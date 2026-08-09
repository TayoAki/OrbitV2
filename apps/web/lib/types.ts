// ─────────────────────────────────────────────────────────────────────────────
// Framework-free domain types (the "@ship/reducer" package equivalent).
// No React, no Next — pure data. State is DERIVED by folding events; there is no
// synthetic `run.state_changed`. See SYSTEM_PLAN §2 / FRONTEND_PLAN §0.
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical backend run_state. The UI never forks this enum — it maps to labels. */
export type RunStateName =
  | "QUEUED"
  | "BUILDING"
  | "REVIEWING"
  | "REVIEW_FEEDBACK"
  | "AWAITING_HUMAN"
  | "MERGING"
  | "DONE"
  | "ESCALATED"
  | "CANCELLED"
  | "FAILED";

/** Severity is a SEPARATE axis from state — it drives color, not layout. */
export type Severity = "active" | "good" | "warn" | "critical" | "idle";

export type CheckState = "success" | "failure" | "pending" | "none";
export type ReviewState = "approved" | "changes_requested" | "reviewing" | "none";

export interface Checks {
  state: CheckState;
  passed?: number;
  total?: number;
}

export interface Review {
  state: ReviewState;
  rounds?: number;
  reviewer?: string;
}

export interface DiffStat {
  additions: number;
  deletions: number;
  files: number;
}

export interface Milestone {
  kind: string;
  text: string;
  atMinutes?: number;
  /** seq at which this milestone was appended (for the flash animation) */
  seq?: number;
}

export interface BlockedReason {
  summary: string;
  token?: string;
  rounds?: number;
}

/** The one run object. Every surface renders a projection of this. */
export interface RunState {
  id: string;
  title: string;
  runState: RunStateName;
  agentId: string;
  requestedById: string;
  repoId: string;
  repoSlug: string;
  prNumber?: number;
  headSha?: string; // client-R8 binds to this
  verdictId?: string; // client-R8 binds to this
  targetBranch: string;
  checks: Checks;
  review: Review;
  diffStat?: DiffStat;
  blockedReason?: BlockedReason;
  ageMinutes: number;
  milestones: Milestone[];
  /** true briefly after an event lands — drives the row/timeline flash */
  flashSeq?: number;
}

export type MemberKind = "human" | "agent";

export interface Member {
  id: string;
  kind: MemberKind;
  name: string;
  handle: string;
  initials: string;
  role: string;
  access?: string;
  /** Present for agents — their runtime config (buzz-inspired). */
  config?: AgentConfig;
}

/** An MCP server an agent is wired to (buzz-dev-mcp gives it shell + editor). */
export interface McpServer {
  name: string;
  command: string;
  tools: string[];
  /** Stable client-side key for list rendering (assigned in the editor). */
  id?: string;
}

/** Agent runtime configuration, modeled on the buzz-agent / buzz-dev-mcp vision. */
export interface AgentConfig {
  model: string; // LLM model id — swappable with one env var in prod
  acpVersion: string; // ACP protocol version the agent reports
  maxSessions: number; // concurrent sessions cap (buzz default 8)
  relayUrl: string; // Nostr relay URL — selects the community
  community: string; // human label for that community
  mcpServers: McpServer[];
  systemPrompt: string;
  presence: "online" | "idle" | "offline";
  autonomy: "supervised" | "autonomous"; // supervised = human approves merges
}

export type ConnectionStatus = "connected" | "not_configured" | "error";

export interface Connection {
  id: string;
  provider: string;
  category: string;
  displayName: string;
  status: ConnectionStatus;
  accountLabel?: string;
  scopeSummary?: string;
  lastSyncedLabel?: string;
}

export interface Repo {
  id: string;
  slug: string;
  defaultBranch: string;
  connected: boolean;
  agentId: string;
}

export interface Org {
  name: string;
  slug: string;
}

// ── Threads (Slack-like collaboration; the Nostr workspace preview) ───────────
export type ChannelKind = "channel" | "dm";

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;
  topic?: string;
  memberIds: string[]; // for DMs: the two participants
}

export type MessageKind = "text" | "system" | "run";

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  at: number;
  text: string;
  mentions: string[]; // member ids @mentioned
  kind: MessageKind;
  runId?: string; // for kind === "run": the run this message links to
}

/** One timeline step from the fixture — the payload of a `step` event. */
export interface Step {
  in: number;
  to?: RunStateName;
  setPr?: boolean;
  checks?: CheckState;
  review?: ReviewState;
  note?: string;
  kind?: string;
}

/** The one event envelope the reducer consumes. State is derived by folding these. */
export type ShipEventType =
  | "created"
  | "step"
  | "flash.clear"
  | "repo.connected"
  | "repo.added"
  | "agent.update"
  | "message.posted"
  | "org.update";

export interface ShipEvent {
  seq: number;
  runId: string;
  type: ShipEventType;
  at: number;
  payload: {
    step?: Step;
    run?: RunState;
    repoId?: string;
    repo?: Repo;
    memberId?: string;
    config?: AgentConfig;
    message?: Message;
    orgName?: string;
    userName?: string;
  };
}

export interface StoreState {
  org: Org;
  currentUserId: string;
  nextPr: number;
  seq: number;
  members: Record<string, Member>;
  connections: Connection[];
  repos: Record<string, Repo>;
  runs: Record<string, RunState>;
  channels: Channel[];
  messages: Record<string, Message[]>; // keyed by channelId
}
