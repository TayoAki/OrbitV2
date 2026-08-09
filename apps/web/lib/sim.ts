// ─────────────────────────────────────────────────────────────────────────────
// The local simulation engine. It stands in for the backend event tail: it plays
// the fixture's `pending` timelines and action `scripts` as ordered events into
// the store. In production this whole file is replaced by a resumable SSE reader;
// the store/reducer/selectors above it never change.
// ─────────────────────────────────────────────────────────────────────────────
import type { Store } from "./store";
import { pendingTimelines, scripts as fixtureScripts } from "./store";
import type { Step, RunState, Repo, Message, AgentConfig, StoreState } from "./types";

const FLASH_MS = 950;

export class SimEngine {
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private started = new Set<string>();
  private newCounter = 0;
  private msgCounter = 0;
  private repoCounter = 0;
  private pending = pendingTimelines();
  private scripts = fixtureScripts();

  constructor(private store: Store, private clockSpeed = 1) {}

  // Play every pending timeline whose repo is already connected.
  start() {
    const state = this.store.getSnapshot();
    for (const [runId, entry] of this.pending) {
      if (state.repos[entry.repoId]?.connected) this.playSteps(runId, entry.steps);
    }
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    // Clear started too, so a re-mount (React StrictMode double-invoke in dev)
    // replays pending timelines instead of early-returning and freezing.
    this.started.clear();
  }

  private scaled(ms: number) {
    return Math.max(120, ms / this.clockSpeed);
  }

  private now() {
    return Date.now();
  }

  private clearFlashSoon(runId: string) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.store.dispatch({ runId, type: "flash.clear", at: this.now(), payload: {} });
    }, FLASH_MS);
    this.timers.add(t);
  }

  /** Run a sequence of steps against one run, honoring each step's delay. */
  private playSteps(runId: string, steps: Step[]) {
    if (this.started.has(runId)) return;
    this.started.add(runId);
    let i = 0;
    const runNext = () => {
      if (i >= steps.length) return;
      const step = steps[i++];
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.store.dispatch({ runId, type: "step", at: this.now(), payload: { step } });
        this.clearFlashSoon(runId);
        runNext();
      }, this.scaled(step.in));
      this.timers.add(t);
    };
    runNext();
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  connectRepo(repoId: string) {
    this.store.dispatch({ runId: "", type: "repo.connected", at: this.now(), payload: { repoId } });
    // Kick off any of this repo's pending timelines that haven't started yet.
    for (const [runId, entry] of this.pending) {
      if (entry.repoId === repoId) this.playSteps(runId, entry.steps);
    }
  }

  startTask(input: { repoId: string; title: string; agentId?: string }): string {
    const state = this.store.getSnapshot();
    const repo = state.repos[input.repoId];
    if (!repo) return "";
    this.newCounter += 1;
    const id = `run_new_${this.newCounter}`;
    const agentId = input.agentId ?? repo.agentId;
    const run: RunState = {
      id,
      title: input.title,
      runState: "QUEUED",
      agentId,
      requestedById: state.currentUserId,
      repoId: repo.id,
      repoSlug: repo.slug,
      targetBranch: repo.defaultBranch,
      checks: { state: "pending" },
      review: { state: "none" },
      diffStat: undefined,
      ageMinutes: 0,
      milestones: [{ kind: "pick", text: "Queued — waiting for an agent", atMinutes: 0 }],
    };
    this.store.dispatch({ runId: id, type: "created", at: this.now(), payload: { run } });
    this.clearFlashSoon(id);
    this.runScript(id, "newTask");
    return id;
  }

  approve(runId: string) {
    this.runScript(runId, "approve");
  }
  requestChanges(runId: string, _note?: string) {
    // _note would ride along to the agent in production; the script covers the
    // visible "you requested changes" milestone here.
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

  // ── Repos & agents ───────────────────────────────────────────────────────

  addRepo(input: { slug: string; defaultBranch?: string; agentId?: string }): string {
    const state = this.store.getSnapshot();
    this.repoCounter += 1;
    const id = `repo_new_${this.repoCounter}`;
    const agentId = input.agentId ?? Object.values(state.members).find((m) => m.kind === "agent")?.id ?? "agt_ship";
    const repo: Repo = {
      id,
      slug: input.slug,
      defaultBranch: input.defaultBranch ?? "main",
      connected: true,
      agentId,
    };
    this.store.dispatch({ runId: "", type: "repo.added", at: this.now(), payload: { repo } });
    return id;
  }

  updateAgent(memberId: string, config: AgentConfig) {
    this.store.dispatch({ runId: "", type: "agent.update", at: this.now(), payload: { memberId, config } });
  }

  updateOrg(orgName?: string, userName?: string) {
    this.store.dispatch({ runId: "", type: "org.update", at: this.now(), payload: { orgName, userName } });
  }

  // ── Threads ──────────────────────────────────────────────────────────────

  private newMsgId() {
    this.msgCounter += 1;
    return `msg_new_${this.msgCounter}`;
  }

  private parseMentions(text: string, state: StoreState): string[] {
    const handles = new Set<string>();
    // Require a non-word char (or start) before '@' so emails / tokens like
    // "ci@shipbot.dev" don't parse "@shipbot" as a mention and start a run.
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
    const msg: Message = {
      id: this.newMsgId(),
      channelId,
      authorId: state.currentUserId,
      at: 0,
      text,
      mentions,
      kind: "text",
    };
    this.store.dispatch({ runId: "", type: "message.posted", at: this.now(), payload: { message: msg } });

    const targets = new Set(mentions.filter((id) => state.members[id]?.kind === "agent"));
    // A DM to an agent is directed even without an explicit @mention.
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
      this.store.dispatch({ runId: "", type: "message.posted", at: this.now(), payload: { message } });
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

  /** Allow a run to be re-driven by a new script after a human action. */
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
