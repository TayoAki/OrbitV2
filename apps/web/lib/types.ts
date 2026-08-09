// ─────────────────────────────────────────────────────────────────────────────
// Framework-free domain contract (the "@ship/reducer" package equivalent).
// No React, no Next — pure data. State is DERIVED by folding TYPED domain events.
//
// This is the contract frozen for the first backend (per the architecture review):
//   • coarse run_state (kept) — no REVIEW_FEEDBACK
//   • typed ShipEvent (no generic "step"); events carry STRUCTURED data, never
//     prewritten UI copy — the frontend derives timeline text via describeEvent()
//   • server-authoritative ordering: event.id (global) + event.seq (per-run)
//   • Task ≠ Run; Verification/Checks/Review/Escalation are first-class
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical backend run_state. The UI maps it to friendly labels. */
export type RunStateName =
  | "QUEUED"
  | "BUILDING"
  | "REVIEWING"
  | "AWAITING_HUMAN"
  | "MERGING"
  | "DONE"
  | "ESCALATED"
  | "CANCELLED"
  | "FAILED";

/** Severity is a SEPARATE axis from state — it drives color, not layout. */
export type Severity = "active" | "good" | "warn" | "critical" | "idle";

// ── CI checks ────────────────────────────────────────────────────────────────
// v1 rendering uses the compact `Checks`. `CheckSuite` is the frozen shape the
// run migrates to once the GitHub App streams individual required checks.
export type CheckState = "success" | "failure" | "pending" | "none";

export interface Checks {
  state: CheckState;
  passed?: number;
  total?: number;
}

export type CheckStatus = "PENDING" | "SUCCESS" | "FAILURE" | "CANCELLED" | "SKIPPED";
export interface Check {
  id: string;
  name: string;
  status: CheckStatus;
  required: boolean;
  url?: string;
}
export interface CheckSuite {
  status: "PENDING" | "PASSED" | "FAILED";
  checks: Check[];
}

// ── Automated review loop ────────────────────────────────────────────────────
export type ReviewState = "approved" | "changes_requested" | "reviewing" | "none";

export interface ReviewRound {
  round: number;
  status: "APPROVED" | "CHANGES_REQUESTED";
  score?: number;
  blockingComments: number;
  startedAt?: string;
  completedAt?: string;
  providerReviewId?: string;
}

export interface Review {
  provider?: string;
  state: ReviewState; // coarse verdict used by selectors (reviewApproved = "approved")
  currentRound: number;
  maxRounds: number;
  reviewer?: string;
  rounds: ReviewRound[];
}

// ── Functional verification (dormant in v1: status = NOT_REQUIRED) ────────────
export type VerificationStatus = "NOT_REQUIRED" | "PENDING" | "RUNNING" | "PASSED" | "FAILED";

export type EvidenceType = "SCREENSHOT" | "VIDEO" | "TRACE" | "LOG" | "TEST_REPORT";
export interface EvidenceArtifact {
  id: string;
  type: EvidenceType;
  url: string;
  label?: string;
}

export interface VerificationAttempt {
  id: string;
  attempt: number;
  status: "RUNNING" | "PASSED" | "FAILED";
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  evidence: EvidenceArtifact[];
}

export interface Verification {
  status: VerificationStatus;
  attempts: VerificationAttempt[];
}

// ── Mergeability ─────────────────────────────────────────────────────────────
export type Mergeability = "UNKNOWN" | "MERGEABLE" | "CONFLICTING" | "BEHIND" | "BLOCKED";

// ── Escalation (human interrupt over any stage) ──────────────────────────────
export type EscalationKind =
  | "CLARIFICATION"
  | "CREDENTIAL"
  | "PERMISSION"
  | "AUTHENTICATION"
  | "REVIEW_LIMIT"
  | "BUILD_LIMIT"
  | "EXTERNAL_FAILURE"
  | "UNKNOWN";

export interface Escalation {
  kind: EscalationKind;
  summary: string;
  question?: string;
  token?: string; // the concrete failing thing (e.g. "webhooks/stripe.test.ts → 3 failing")
  resumeFrom: "BUILDING" | "REVIEWING" | "MERGING";
  data?: Record<string, unknown>;
}

export interface DiffStat {
  additions: number;
  deletions: number;
  files: number;
}

// ── Events ───────────────────────────────────────────────────────────────────
export type EventSource =
  | "control_plane"
  | "workflow"
  | "sandbox"
  | "agent"
  | "github"
  | "review_provider"
  | "human";

/** Typed domain events. The reducer folds these into coarse run_state. */
export type ShipEventType =
  // run lifecycle
  | "run.created"
  | "sandbox.provisioning"
  | "sandbox.ready"
  | "sandbox.failed"
  | "agent.started"
  | "agent.progress"
  | "agent.completed"
  | "agent.failed"
  | "git.branch_created"
  | "git.commit_created"
  | "git.push_completed"
  | "pr.created"
  | "ci.started"
  | "ci.passed"
  | "ci.failed"
  | "verification.started"
  | "verification.passed"
  | "verification.failed"
  | "review.started"
  | "review.approved"
  | "review.changes_requested"
  | "revision.started"
  | "revision.pushed"
  | "run.escalated"
  | "run.resumed"
  | "run.cancelled"
  | "human.approval_requested"
  | "human.changes_requested"
  | "human.approved"
  | "merge.started"
  | "merge.completed"
  | "merge.failed"
  // workspace / config (not run-scoped)
  | "repo.connected"
  | "repo.added"
  | "agent.update"
  | "message.posted"
  | "org.update"
  // ui-ephemeral
  | "flash.clear";

/**
 * Structured event payload. NO prewritten UI sentence — the frontend derives
 * copy from these fields (describeEvent). `text` is only a fallback for seeded
 * history whose structured fields we didn't backfill.
 */
export interface EventData {
  toState?: RunStateName;
  checks?: CheckState;
  review?: ReviewState;
  round?: number;
  blockingComments?: number;
  prNumber?: number;
  headSha?: string;
  attempt?: number;
  escalation?: Escalation;
  mergeability?: Mergeability;
  // run.created carries the run + its task
  run?: RunState;
  task?: Task;
  // workspace/config event fields
  repo?: Repo;
  repoId?: string;
  memberId?: string;
  config?: AgentConfig;
  message?: Message;
  orgName?: string;
  userName?: string;
  text?: string; // seed-history fallback only
}

/** The authoritative event envelope. seq is per-run (monotonic within a run). */
export interface ShipEvent {
  id: string; // globally unique, assigned by the event store
  runId: string; // "" for workspace-scoped config events
  seq: number; // per-run monotonic
  type: ShipEventType;
  source: EventSource;
  createdAt: string; // ISO
  payload: EventData;
}

/** The per-run event log entry the run carries (a projection of ShipEvent). */
export interface RunEvent {
  id: string;
  seq: number;
  type: ShipEventType;
  source: EventSource;
  at: string; // ISO
  atMinutes?: number; // relative age for seeded history
  data?: EventData;
}

// ── Task ≠ Run ───────────────────────────────────────────────────────────────
export interface TaskSource {
  type: "orbit" | "linear" | "github_issue";
  externalId?: string;
  externalUrl?: string;
}

export interface Task {
  id: string;
  source: TaskSource;
  repoId: string;
  description: string; // what the human wants built
  acceptanceCriteria: string; // what the verifier must prove ("" = none given)
  requestedById: string;
  createdAt: string;
}

/** The one run object. Every surface renders a projection of this. */
export interface RunState {
  id: string;
  taskId: string;
  title: string; // convenience mirror of task.description
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
  verification: Verification;
  mergeability: Mergeability;
  diffStat?: DiffStat;
  escalation?: Escalation;
  ageMinutes: number;
  events: RunEvent[]; // the per-run event log (was: milestones)
  flashSeq?: number; // per-run seq that just landed — drives the flash
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
  config?: AgentConfig; // agents only
}

export interface McpServer {
  name: string;
  command: string;
  tools: string[];
  id?: string;
}

export interface AgentConfig {
  model: string;
  acpVersion: string;
  maxSessions: number;
  relayUrl: string;
  community: string;
  mcpServers: McpServer[];
  systemPrompt: string;
  presence: "online" | "idle" | "offline";
  autonomy: "supervised" | "autonomous";
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
  memberIds: string[];
}

export type MessageKind = "text" | "system" | "run";

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  at: number;
  text: string;
  mentions: string[];
  kind: MessageKind;
  runId?: string;
}

/** A fixture authoring step (sim-only). The SimEngine translates each Step into
 *  one typed ShipEvent. NOT part of the production contract. */
export interface Step {
  in: number;
  to?: RunStateName;
  setPr?: boolean;
  checks?: CheckState;
  review?: ReviewState;
  note?: string;
  kind?: string;
}

export interface StoreState {
  org: Org;
  currentUserId: string;
  nextPr: number;
  cursor: string; // last applied event id (SSE resume cursor)
  members: Record<string, Member>;
  connections: Connection[];
  repos: Record<string, Repo>;
  tasks: Record<string, Task>;
  runs: Record<string, RunState>;
  channels: Channel[];
  messages: Record<string, Message[]>;
}
