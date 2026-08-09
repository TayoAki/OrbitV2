// ─────────────────────────────────────────────────────────────────────────────
// The one normalized store. In production this is fed by a resumable SSE tail
// (snapshot at N, stream from N+1). Here the same interface is fed by the local
// SimEngine (lib/sim). Every surface reads it through selectors — no surface owns
// run state. (FRONTEND_PLAN §0)
// ─────────────────────────────────────────────────────────────────────────────
import simData from "@/data/simulation.json";
import type {
  StoreState,
  ShipEvent,
  RunState,
  Member,
  Connection,
  Repo,
  Step,
  Checks,
  Review,
  DiffStat,
  BlockedReason,
  Milestone,
  RunStateName,
  AgentConfig,
  Channel,
  Message,
} from "./types";
import { applyEvent } from "./reducer";

// ── Fixture typing (permissive; JSON is cast once here) ──────────────────────
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
  checks?: Checks;
  review?: Review;
  diffStat?: DiffStat;
  blockedReason?: BlockedReason;
  ageMinutes?: number;
  milestones?: Milestone[];
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

// Repos connected on first load. repo_api starts connected so the inbox is
// populated immediately (matches the reference); the others are connected live
// from the Connections screen to demo "connect → inbox populates / or nothing".
const DEFAULT_CONNECTED = new Set<string>(["repo_api"]);

function seedToRun(seed: SeedRun, repo: SeedRepo): RunState {
  return {
    id: seed.id,
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
    checks: seed.checks ?? { state: "none" },
    review: seed.review ?? { state: "none" },
    diffStat: seed.diffStat,
    blockedReason: seed.blockedReason,
    ageMinutes: seed.ageMinutes ?? 0,
    milestones: (seed.milestones ?? []).map((m) => ({ ...m })),
  };
}

// Default buzz-inspired runtime config per agent. Editable at runtime.
const AGENT_CONFIGS: Record<string, AgentConfig> = {
  agt_ship: {
    model: "claude-sonnet-4.5",
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
    id,
    channelId,
    authorId,
    at,
    text,
    mentions,
    kind,
    runId,
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
  for (const repo of fixture.repos) {
    repos[repo.id] = {
      id: repo.id,
      slug: repo.slug,
      defaultBranch: repo.defaultBranch,
      connected: DEFAULT_CONNECTED.has(repo.id) ? true : !!repo.connected,
      agentId: repo.agentId,
    };
    for (const seed of repo.seedRuns) runs[seed.id] = seedToRun(seed, repo);
  }

  return {
    org: fixture.org,
    currentUserId: fixture.currentUserId,
    nextPr: fixture.config.nextPr,
    seq: 0,
    members,
    connections: fixture.connections.map((c) => ({ ...c })),
    repos,
    runs,
    channels: seedChannels(),
    messages: seedMessages(),
  };
}

/** Pending timelines + scripts, sourced straight from the fixture. */
export function pendingTimelines(): Map<string, { repoId: string; steps: Step[] }> {
  const map = new Map<string, { repoId: string; steps: Step[] }>();
  for (const repo of fixture.repos) {
    for (const seed of repo.seedRuns) {
      if (seed.pending && seed.pending.length) {
        map.set(seed.id, { repoId: repo.id, steps: seed.pending });
      }
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
  /** Assigns the next seq, folds the event, notifies subscribers. */
  dispatch: (ev: Omit<ShipEvent, "seq">) => ShipEvent;
}

export function createStore(initial?: StoreState): Store {
  let state = initial ?? buildInitialState();
  let seq = state.seq;
  const listeners = new Set<Listener>();

  return {
    getSnapshot: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    dispatch: (partial) => {
      seq += 1;
      const ev: ShipEvent = { ...partial, seq };
      state = applyEvent(state, ev);
      listeners.forEach((l) => l());
      return ev;
    },
  };
}
