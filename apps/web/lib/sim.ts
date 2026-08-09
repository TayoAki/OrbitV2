// ─────────────────────────────────────────────────────────────────────────────
// The local simulation engine — the mock run driver + ordering authority. It
// stands in for the backend event tail: it stamps every event with a global id
// and a per-run seq, translates the fixture's `Step` scripts into TYPED domain
// events, and applies them to the store. In production this whole file is
// replaced by an SSE reader; the store/reducer/selectors above it never change.
// (Rename target once the backend exists: MockRunDriver.)
// ─────────────────────────────────────────────────────────────────────────────
import type { Store } from "./store";
import { pendingTimelines, scripts as fixtureScripts } from "./store";
import { stepKindToEventType } from "./labels";
import type {
  Step,
  RunState,
  Repo,
  Task,
  Message,
  AgentConfig,
  StoreState,
  ShipEvent,
  ShipEventType,
  EventSource,
  EventData,
} from "./types";

const FLASH_MS = 950;

function sourceFor(type: ShipEventType): EventSource {
  if (type.startsWith("ci.")) return "github";
  if (type.startsWith("git.")) return "sandbox";
  if (type.startsWith("review.")) return "review_provider";
  if (type.startsWith("verification.")) return "sandbox";
  if (type.startsWith("sandbox.")) return "workflow";
  if (type.startsWith("human.")) return "human";
  if (type === "pr.created" || type.startsWith("merge.") || type === "run.created") return "control_plane";
  if (type === "run.escalated" || type === "run.resumed" || type === "run.cancelled") return "workflow";
  return "agent";
}

export class SimEngine {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private started = new Set<string>();
  private newCounter = 0;
  private msgCounter = 0;
  private repoCounter = 0;
  private ordinal = 0; // global event id counter
  private runSeq = new Map<string, number>(); // per-run seq
  private pending = pendingTimelines();
  private scripts = fixtureScripts();

  constructor(private store: Store, private clockSpeed = 1) {}

  start() {
    const state = this.store.getSnapshot();
    for (const [runId, entry] of this.pending) {
      if (state.repos[entry.repoId]?.connected) this.playSteps(runId, entry.steps);
    }
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.started.clear();
  }

  private scaled(ms: number) {
    return Math.max(120, ms / this.clockSpeed);
  }

  private now() {
    return new Date().toISOString();
  }

  /** Per-run seq that continues past any seeded events (avoids seq collisions
   *  that would flash a stale timeline row). */
  private nextSeq(runId: string): number {
    if (!this.runSeq.has(runId)) {
      const run = runId ? this.store.getSnapshot().runs[runId] : undefined;
      const base = run ? run.events.reduce((mx, e) => Math.max(mx, e.seq), 0) : 0;
      this.runSeq.set(runId, base);
    }
    const seq = (this.runSeq.get(runId) ?? 0) + 1;
    this.runSeq.set(runId, seq);
    return seq;
  }

  /** Stamp id + per-run seq + source, then apply. The store never invents seq. */
  private emit(runId: string, type: ShipEventType, payload: EventData): ShipEvent {
    this.ordinal += 1;
    const seq = this.nextSeq(runId);
    const ev: ShipEvent = {
      id: `evt_${this.ordinal}`,
      runId,
      seq,
      type,
      source: sourceFor(type),
      createdAt: this.now(),
      payload,
    };
    return this.store.apply(ev);
  }

  private clearFlashSoon(runId: string) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.emit(runId, "flash.clear", {});
    }, FLASH_MS);
    this.timers.add(t);
  }

  private interp(runId: string, note: string | undefined): string | undefined {
    if (!note) return undefined;
    const s = this.store.getSnapshot();
    const run = s.runs[runId];
    return note.replace(/\{repo\}/g, run?.repoSlug ?? "").replace(/\{pr\}/g, String(s.nextPr));
  }

  /** Translate one fixture Step into a typed event (type + structured payload). */
  private stepEvent(runId: string, step: Step): { type: ShipEventType; payload: EventData } {
    let type: ShipEventType;
    if (step.to === "MERGING") type = "merge.started";
    else if (step.to === "DONE") type = "merge.completed";
    else if (step.to === "CANCELLED") type = "run.cancelled";
    else type = stepKindToEventType(step.kind, step.to);

    const payload: EventData = { toState: step.to, text: this.interp(runId, step.note) };
    if (step.checks) payload.checks = step.checks;
    if (step.review) payload.review = step.review;
    if (type === "review.changes_requested") payload.blockingComments = 2;
    // pr.created: leave prNumber unset so the reducer stays the PR-number authority;
    // the {pr} in the note was interpolated with the same nextPr it will assign.
    return { type, payload };
  }

  private playSteps(runId: string, steps: Step[]) {
    if (this.started.has(runId)) return;
    this.started.add(runId);
    let i = 0;
    const runNext = () => {
      if (i >= steps.length) return;
      const step = steps[i++];
      const t = setTimeout(() => {
        this.timers.delete(t);
        const { type, payload } = this.stepEvent(runId, step);
        this.emit(runId, type, payload);
        this.clearFlashSoon(runId);
        runNext();
      }, this.scaled(step.in));
      this.timers.add(t);
    };
    runNext();
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  connectRepo(repoId: string) {
    this.emit("", "repo.connected", { repoId });
    for (const [runId, entry] of this.pending) {
      if (entry.repoId === repoId) this.playSteps(runId, entry.steps);
    }
  }

  startTask(input: { repoId: string; title: string; acceptanceCriteria?: string; agentId?: string }): string {
    const state = this.store.getSnapshot();
    const repo = state.repos[input.repoId];
    if (!repo) return "";
    this.newCounter += 1;
    const id = `run_new_${this.newCounter}`;
    const taskId = `task_new_${this.newCounter}`;
    const agentId = input.agentId ?? repo.agentId;

    const task: Task = {
      id: taskId,
      source: { type: "orbit" },
      repoId: repo.id,
      description: input.title,
      acceptanceCriteria: input.acceptanceCriteria?.trim() ?? "",
      requestedById: state.currentUserId,
      createdAt: this.now(),
    };
    const run: RunState = {
      id,
      taskId,
      title: input.title,
      runState: "QUEUED",
      agentId,
      requestedById: state.currentUserId,
      repoId: repo.id,
      repoSlug: repo.slug,
      targetBranch: repo.defaultBranch,
      checks: { state: "pending" },
      review: { state: "none", currentRound: 0, maxRounds: 3, rounds: [] },
      verification: { status: "NOT_REQUIRED", attempts: [] },
      mergeability: "MERGEABLE",
      diffStat: undefined,
      escalation: undefined,
      ageMinutes: 0,
      events: [],
    };
    this.emit(id, "run.created", { run, task, text: "Queued — waiting for an agent" });
    this.clearFlashSoon(id);
    this.runScript(id, "newTask");
    return id;
  }

  approve(runId: string) {
    this.runScript(runId, "approve");
  }
  requestChanges(runId: string, _note?: string) {
    this.restart(runId);
    this.runScript(runId, "requestChanges");
  }
  continueRun(runId: string) {
    this.restart(runId);
    this.runScript(runId, "continueBlocked");
  }
  abortRun(runId: string) {
    this.runScript(runId, "abort");
  }

  // ── Repos & agents ─────────────────────────────────────────────────────────

  addRepo(input: { slug: string; defaultBranch?: string; agentId?: string }): string {
    const state = this.store.getSnapshot();
    this.repoCounter += 1;
    const id = `repo_new_${this.repoCounter}`;
    const agentId = input.agentId ?? Object.values(state.members).find((m) => m.kind === "agent")?.id ?? "agt_ship";
    const repo: Repo = { id, slug: input.slug, defaultBranch: input.defaultBranch ?? "main", connected: true, agentId };
    this.emit("", "repo.added", { repo });
    return id;
  }

  updateAgent(memberId: string, config: AgentConfig) {
    this.emit("", "agent.update", { memberId, config });
  }

  updateOrg(orgName?: string, userName?: string) {
    this.emit("", "org.update", { orgName, userName });
  }

  // ── Threads ────────────────────────────────────────────────────────────────

  private newMsgId() {
    this.msgCounter += 1;
    return `msg_new_${this.msgCounter}`;
  }

  private parseMentions(text: string, state: StoreState): string[] {
    const handles = new Set<string>();
    const re = /(?<![A-Za-z0-9_])@([a-z0-9_-]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) handles.add(m[1].toLowerCase());
    const ids: string[] = [];
    for (const member of Object.values(state.members)) {
      if (handles.has(member.handle.toLowerCase())) ids.push(member.id);
    }
    return ids;
  }

  postMessage(channelId: string, text: string, scopeRepoId: string | null = null) {
    const state = this.store.getSnapshot();
    const mentions = this.parseMentions(text, state);
    const msg: Message = { id: this.newMsgId(), channelId, authorId: state.currentUserId, at: 0, text, mentions, kind: "text" };
    this.emit("", "message.posted", { message: msg });

    const targets = new Set(mentions.filter((id) => state.members[id]?.kind === "agent"));
    const ch = state.channels.find((c) => c.id === channelId);
    if (ch?.kind === "dm") {
      const agentId = ch.memberIds.find((id) => state.members[id]?.kind === "agent");
      if (agentId) targets.add(agentId);
    }
    for (const agentId of targets) this.agentRespond(channelId, agentId, text, scopeRepoId);
  }

  private agentRespond(channelId: string, agentId: string, userText: string, scopeRepoId: string | null) {
    const post = (m: Omit<Message, "id" | "channelId" | "at" | "mentions">) => {
      const message: Message = { id: this.newMsgId(), channelId, at: 0, mentions: [], ...m };
      this.emit("", "message.posted", { message });
    };
    const t1 = setTimeout(() => {
      this.timers.delete(t1);
      const state = this.store.getSnapshot();
      const repo = scopeRepoId ? state.repos[scopeRepoId] : Object.values(state.repos).find((r) => r.connected);
      const task = userText.replace(/@[a-z0-9_-]+/gi, "").trim();
      if (repo && task.length > 8) {
        post({ authorId: agentId, kind: "text", text: `On it — starting a run in ${repo.slug}.` });
        const runId = this.startTask({ repoId: repo.id, title: task, agentId });
        const t2 = setTimeout(() => {
          this.timers.delete(t2);
          post({ authorId: agentId, kind: "run", runId, text: `Opened a run for “${task}”. I'll post here when it needs you.` });
        }, this.scaled(1400));
        this.timers.add(t2);
      } else if (!repo) {
        post({ authorId: agentId, kind: "text", text: "Connect a repository first and I'll get to work." });
      } else {
        post({ authorId: agentId, kind: "text", text: `Hi — tell me what to build and I'll open a run in ${repo.slug}.` });
      }
    }, this.scaled(1100));
    this.timers.add(t1);
  }

  private restart(runId: string) {
    this.started.delete(runId);
  }

  private runScript(runId: string, name: string) {
    const steps = this.scripts[name];
    if (!steps) return;
    this.restart(runId);
    this.playSteps(runId, steps);
  }
}
