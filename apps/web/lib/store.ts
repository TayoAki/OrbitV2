// ─────────────────────────────────────────────────────────────────────────────
// The one normalized store. In production it's fed by a resumable SSE tail
// (snapshot + cursor + tail); the events arrive already sequenced by the backend.
// Here the same interface is fed by the local SimEngine, which is the ordering
// authority (it stamps event.id + per-run seq). The store never invents seq.
// ─────────────────────────────────────────────────────────────────────────────
import simData from "@/data/simulation.json";
import type {
  StoreState,
  ShipEvent,
  RunState,
  RunEvent,
  Member,
  Connection,
  Repo,
  Task,
  Step,
  Checks,
  DiffStat,
  ReviewState,
  RunStateName,
  AgentConfig,
  Channel,
  Message,
  ReviewRound,
  VerificationAttempt,
  VerificationStatus,
  EvidenceArtifact,
  CriterionResult,
} from "./types";
import { applyEvent } from "./reducer";
import { stepKindToEventType } from "./labels";

// ── Fixture authoring shapes (sim-only; NOT the production contract) ──────────
interface SeedReview { state: ReviewState; rounds?: number; reviewer?: string; }
interface SeedMilestone { kind: string; text: string; atMinutes?: number; }
interface SeedBlocked { summary: string; token?: string; rounds?: number; }
interface SeedReviewRound { round: number; status: "APPROVED" | "CHANGES_REQUESTED"; score?: number; blockingComments?: number; }
interface SeedVerify { status?: VerificationStatus; attempts: { attempt: number; status: "PASSED" | "FAILED" | "RUNNING"; criteria?: CriterionResult[]; evidence?: EvidenceArtifact[] }[]; }
interface SeedRun {
  id: string;
  title: string;
  runState: RunStateName;
  agentId: string;
  requestedById: string;
  prNumber?: number;
  headSha?: string;
  verdictId?: string;
  targetBranch: string;
  runtime?: string;
  checks?: Checks;
  review?: SeedReview;
  reviewRounds?: SeedReviewRound[];
  verify?: SeedVerify;
  prEvidence?: EvidenceArtifact[];
  diffStat?: DiffStat;
  blockedReason?: SeedBlocked;
  ageMinutes?: number;
  milestones?: SeedMilestone[];
  pending?: Step[];
}
interface SeedRepo {
  id: string;
  slug: string;
  defaultBranch: string;
  connected: boolean;
  agentId: string;
  seedRuns: SeedRun[];
}
export interface Fixture {
  org: { name: string; slug: string };
  currentUserId: string;
  config: { nextPr: number; clockSpeed: number };
  members: Member[];
  connections: Connection[];
  repos: SeedRepo[];
  scripts: Record<string, Step[]>;
}

export const fixture = simData as unknown as Fixture;

const DEFAULT_CONNECTED = new Set<string>(["repo_api"]);

function seedToTask(seed: SeedRun, repo: SeedRepo): Task {
  return {
    id: `task_${seed.id}`,
    source: { type: "orbit" },
    repoId: repo.id,
    description: seed.title,
    acceptanceCriteria: "",
    requestedById: seed.requestedById,
    createdAt: "",
  };
}

function seedToRun(seed: SeedRun, repo: SeedRepo): RunState {
  const events: RunEvent[] = (seed.milestones ?? []).map((m, i) => ({
    id: `seed_${seed.id}_${i}`,
    seq: i + 1,
    // A 'review' milestone whose copy describes an approval is a review.approved,
    // not changes_requested (the fixture kind can't express approval directly).
    type: m.kind === "review" && /approv/i.test(m.text) ? "review.approved" : stepKindToEventType(m.kind),
    source: "agent",
    at: "",
    atMinutes: m.atMinutes,
    data: { text: m.text },
  }));
  const reviewRounds: ReviewRound[] = (seed.reviewRounds ?? []).map((r) => ({
    round: r.round,
    status: r.status,
    score: r.score,
    blockingComments: r.blockingComments ?? 0,
  }));
  const attempts: VerificationAttempt[] = (seed.verify?.attempts ?? []).map((a) => ({
    id: `va_${seed.id}_${a.attempt}`,
    attempt: a.attempt,
    status: a.status,
    criteria: a.criteria,
    evidence: a.evidence ?? [],
  }));
  return {
    id: seed.id,
    taskId: `task_${seed.id}`,
    title: seed.title,
    runState: seed.runState,
    agentId: seed.agentId,
    requestedById: seed.requestedById,
    repoId: repo.id,
    repoSlug: repo.slug,
    prNumber: seed.prNumber,
    headSha: seed.headSha,
    verdictId: seed.verdictId,
    targetBranch: seed.targetBranch ?? repo.defaultBranch,
    runtime: seed.runtime,
    checks: seed.checks ?? { state: "none" },
    review: {
      provider: seed.review?.reviewer,
      state: seed.review?.state ?? "none",
      currentRound: seed.review?.rounds ?? reviewRounds.length,
      maxRounds: 3,
      reviewer: seed.review?.reviewer,
      rounds: reviewRounds,
    },
    verification: { status: seed.verify?.status ?? (attempts.length ? "PASSED" : "NOT_REQUIRED"), attempts },
    prEvidence: seed.prEvidence,
    mergeability: "MERGEABLE",
    diffStat: seed.diffStat,
    escalation: seed.blockedReason
      ? {
          kind: "REVIEW_LIMIT",
          summary: seed.blockedReason.summary,
          token: seed.blockedReason.token,
          resumeFrom: "BUILDING",
          question: "The agent stopped after too many review rounds. Continue with a hint, or abort?",
        }
      : undefined,
    ageMinutes: seed.ageMinutes ?? 0,
    events,
  };
}

const AGENT_CONFIGS: Record<string, AgentConfig> = {
  agt_ship: {
    model: "claude-sonnet-4.5",
    runtime: "copilot",
    acpVersion: "1.0",
    maxSessions: 8,
    relayUrl: "wss://relay.acme.dev",
    community: "Acme Eng",
    mcpServers: [{ name: "buzz-dev-mcp", command: "buzz-dev-mcp", tools: ["shell", "str_replace", "todo"] }],
    systemPrompt:
      "You are ShipBot, a senior engineer. Open small, well-tested pull requests. Prefer deleting code to adding it. If you cannot proceed, stop and explain why.",
    presence: "online",
    autonomy: "supervised",
  },
  agt_fix: {
    model: "claude-haiku-4.5",
    runtime: "cursor",
    acpVersion: "1.0",
    maxSessions: 4,
    relayUrl: "wss://relay.acme.dev",
    community: "Acme Eng",
    mcpServers: [
      { name: "buzz-dev-mcp", command: "buzz-dev-mcp", tools: ["shell", "str_replace", "todo"] },
      { name: "buzz-search-mcp", command: "buzz-search-mcp", tools: ["grep", "tree"] },
    ],
    systemPrompt:
      "You are FixBot. You reproduce and fix flaky tests and small bugs. Always add a regression test. Keep diffs minimal.",
    presence: "idle",
    autonomy: "supervised",
  },
};

function seedChannels(): Channel[] {
  return [
    { id: "ch_general", kind: "channel", name: "general", topic: "Company-wide chatter", memberIds: ["usr_dana", "usr_ravi", "usr_mira", "agt_ship", "agt_fix"] },
    { id: "ch_eng", kind: "channel", name: "engineering", topic: "Ship things · mention an agent to start a run", memberIds: ["usr_dana", "usr_ravi", "usr_mira", "agt_ship", "agt_fix"] },
    { id: "ch_approvals", kind: "channel", name: "approvals", topic: "Runs that need a human", memberIds: ["usr_dana", "usr_ravi", "usr_mira", "agt_ship", "agt_fix"] },
    { id: "dm_ship", kind: "dm", name: "ShipBot", memberIds: ["usr_dana", "agt_ship"] },
    { id: "dm_fix", kind: "dm", name: "FixBot", memberIds: ["usr_dana", "agt_fix"] },
  ];
}

function seedMessages(): Record<string, Message[]> {
  const mk = (id: string, channelId: string, authorId: string, at: number, text: string, mentions: string[] = [], kind: Message["kind"] = "text", runId?: string): Message => ({
    id, channelId, authorId, at, text, mentions, kind, runId,
  });
  return {
    ch_general: [mk("m_g1", "ch_general", "usr_mira", 180, "welcome to the workspace 👋 agents live here too")],
    ch_eng: [
      mk("m_e1", "ch_eng", "usr_ravi", 42, "morning — is anyone on the export rate-limit headers?"),
      mk("m_e2", "ch_eng", "usr_dana", 40, "@shipbot can you take the /export rate-limit headers?", ["agt_ship"]),
      mk("m_e3", "ch_eng", "agt_ship", 38, "On it. Opened PR #846 — CI green, awaiting your approval.", [], "text"),
    ],
    ch_approvals: [mk("m_a1", "ch_approvals", "agt_ship", 12, "Runs land here when they need a human. #841 and #846 are ready for you.")],
    dm_ship: [mk("m_d1", "dm_ship", "agt_ship", 60, "Hi Dana — I'm online. @mention me in a channel or here to start a task.")],
    dm_fix: [mk("m_f1", "dm_fix", "agt_fix", 90, "FixBot here. Send me a flaky test and I'll reproduce + fix it.")],
  };
}

export function buildInitialState(): StoreState {
  const members: Record<string, Member> = {};
  for (const m of fixture.members) {
    members[m.id] = m.kind === "agent" && AGENT_CONFIGS[m.id] ? { ...m, config: AGENT_CONFIGS[m.id] } : m;
  }

  const repos: Record<string, Repo> = {};
  const runs: Record<string, RunState> = {};
  const tasks: Record<string, Task> = {};
  for (const repo of fixture.repos) {
    repos[repo.id] = {
      id: repo.id,
      slug: repo.slug,
      defaultBranch: repo.defaultBranch,
      connected: DEFAULT_CONNECTED.has(repo.id) ? true : !!repo.connected,
      agentId: repo.agentId,
    };
    for (const seed of repo.seedRuns) {
      runs[seed.id] = seedToRun(seed, repo);
      tasks[`task_${seed.id}`] = seedToTask(seed, repo);
    }
  }

  return {
    org: fixture.org,
    currentUserId: fixture.currentUserId,
    nextPr: fixture.config.nextPr,
    cursor: "evt_0",
    members,
    connections: fixture.connections.map((c) => ({ ...c })),
    repos,
    tasks,
    runs,
    channels: seedChannels(),
    messages: seedMessages(),
  };
}

export function pendingTimelines(): Map<string, { repoId: string; steps: Step[] }> {
  const map = new Map<string, { repoId: string; steps: Step[] }>();
  for (const repo of fixture.repos) {
    for (const seed of repo.seedRuns) {
      if (seed.pending && seed.pending.length) map.set(seed.id, { repoId: repo.id, steps: seed.pending });
    }
  }
  return map;
}

export function scripts(): Record<string, Step[]> {
  return fixture.scripts;
}

// ── Store ────────────────────────────────────────────────────────────────────
type Listener = () => void;

export interface Store {
  getSnapshot: () => StoreState;
  subscribe: (l: Listener) => () => void;
  /** Fold a fully-sequenced event (id + per-run seq assigned upstream). */
  apply: (ev: ShipEvent) => ShipEvent;
}

export function createStore(initial?: StoreState): Store {
  let state = initial ?? buildInitialState();
  const listeners = new Set<Listener>();
  return {
    getSnapshot: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    apply: (ev) => {
      state = applyEvent(state, ev);
      listeners.forEach((l) => l());
      return ev;
    },
  };
}
