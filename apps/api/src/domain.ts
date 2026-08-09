// ─────────────────────────────────────────────────────────────────────────────
// Domain contract — the Run is the canonical object. The board, inbox, GitHub
// thread, PR, CI, review, and executor are projections/resources attached to it.
// State is derived by folding events; every externally-triggered transition is
// bound to a Git commit SHA. (Blueprint §"Run model and state machine".)
// ─────────────────────────────────────────────────────────────────────────────

/** The detailed internal run state. The UI collapses this via UI_STATE below. */
export type RunState =
  | "QUEUED"
  | "PROVISIONING"
  | "BUILDING"
  | "PR_OPEN"
  | "CI_WAIT"
  | "FIXING_CI"
  | "REVIEWING"
  | "FIXING_REVIEW"
  | "VERIFYING"
  | "FIXING_BROWSER"
  | "AWAITING_HUMAN"
  | "MERGING"
  | "DONE"
  | "BLOCKED"
  | "FAILED"
  | "CANCELLED";

/** The coarse state the frontend renders (mirrors apps/web RunStateName). */
export type UiState =
  | "QUEUED"
  | "BUILDING"
  | "REVIEWING"
  | "AWAITING_HUMAN"
  | "MERGING"
  | "DONE"
  | "ESCALATED"
  | "CANCELLED"
  | "FAILED";

export const UI_STATE: Record<RunState, UiState> = {
  QUEUED: "QUEUED",
  PROVISIONING: "QUEUED",
  BUILDING: "BUILDING",
  PR_OPEN: "BUILDING",
  CI_WAIT: "REVIEWING",
  FIXING_CI: "BUILDING",
  REVIEWING: "REVIEWING",
  FIXING_REVIEW: "BUILDING",
  VERIFYING: "REVIEWING",
  FIXING_BROWSER: "BUILDING",
  AWAITING_HUMAN: "AWAITING_HUMAN",
  MERGING: "MERGING",
  DONE: "DONE",
  BLOCKED: "ESCALATED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["DONE", "FAILED", "CANCELLED"]);
export function isTerminal(s: RunState): boolean {
  return TERMINAL_STATES.has(s);
}

/** States from which a user cancel is accepted (before terminal / merge). */
export const CANCELLABLE_STATES: ReadonlySet<RunState> = new Set([
  "QUEUED",
  "PROVISIONING",
  "BUILDING",
  "PR_OPEN",
  "CI_WAIT",
  "FIXING_CI",
  "REVIEWING",
  "FIXING_REVIEW",
  "VERIFYING",
  "FIXING_BROWSER",
  "AWAITING_HUMAN",
  "BLOCKED",
]);

/** Allowed transitions — a guard, not the whole logic. */
const TRANSITIONS: Record<RunState, RunState[]> = {
  QUEUED: ["PROVISIONING", "CANCELLED", "FAILED"],
  PROVISIONING: ["BUILDING", "CANCELLED", "FAILED"],
  BUILDING: ["PR_OPEN", "FAILED", "CANCELLED", "BLOCKED"],
  PR_OPEN: ["CI_WAIT", "CANCELLED"],
  // The gate-wait states can escalate straight to BLOCKED when a repair budget is
  // exhausted (the exhaustion check fires before re-entering a FIXING_* state).
  CI_WAIT: ["FIXING_CI", "REVIEWING", "BLOCKED", "CANCELLED"],
  FIXING_CI: ["CI_WAIT", "BLOCKED", "CANCELLED"],
  REVIEWING: ["FIXING_REVIEW", "VERIFYING", "BLOCKED", "CANCELLED"],
  FIXING_REVIEW: ["CI_WAIT", "BLOCKED", "CANCELLED"],
  VERIFYING: ["FIXING_BROWSER", "AWAITING_HUMAN", "BLOCKED", "CANCELLED"],
  FIXING_BROWSER: ["CI_WAIT", "BLOCKED", "CANCELLED"],
  AWAITING_HUMAN: ["MERGING", "CI_WAIT", "CANCELLED", "BLOCKED"],
  MERGING: ["DONE", "AWAITING_HUMAN", "FAILED"],
  DONE: [],
  BLOCKED: ["CI_WAIT", "CANCELLED"],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return from === to || TRANSITIONS[from]?.includes(to) === true;
}

// ── Attention (the inbox is a query over these) ──────────────────────────────
export type AttentionReason =
  | "READY_TO_MERGE"
  | "NEEDS_INPUT"
  | "AUTOMATION_EXHAUSTED"
  | "POLICY_BLOCKED"
  | "EXECUTOR_INCOMPATIBLE"
  | "EXTERNAL_SERVICE_FAILED";

// ── Repair budgets (the money ceiling) ───────────────────────────────────────
export const CAPS = {
  CI_REPAIR_MAX: 3,
  /** Number of REVIEWER EXECUTIONS (round 1 initial + 2 revisions), not extra rounds. */
  REVIEW_ROUNDS_MAX: 3,
  BROWSER_REPAIR_MAX: 3,
} as const;

// ── Value objects ────────────────────────────────────────────────────────────
export type ExecutionMode = "SUPERVISED" | "AUTONOMOUS";

export interface AcceptanceCriteria {
  criteria: string[];
  browserRequired: boolean;
}

export type RunSourceType = "BOARD" | "GITHUB_COMMENT" | "ISSUE" | "PR" | "API";
export interface RunSource {
  type: RunSourceType;
  externalId?: string;
}

export interface Run {
  id: string;
  workspaceId: string;
  repositoryId: string;
  creatorUserId: string;
  source: RunSource;
  title: string;
  instructions: string;
  acceptanceCriteria: AcceptanceCriteria;
  executionMode: ExecutionMode;
  state: RunState;
  /** Optimistic-concurrency guard. */
  stateVersion: number;
  baseRef: string;
  baseSha: string;
  branchName: string | null;
  headSha: string | null;
  prNumber: number | null;
  ciRepairAttempts: number;
  /** Number of reviewer executions consumed so far. */
  reviewRound: number;
  browserRepairAttempts: number;
  /** Hash of the immutable gate snapshot the run is currently gated on. */
  gateHash: string | null;
  attentionReason: AttentionReason | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Append-only lifecycle/audit record. `(source, idempotencyKey)` is unique. */
export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  eventType: EventName;
  source: EventSource;
  headSha: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type EventSource = "control_plane" | "runner" | "github" | "review_provider" | "human" | "reconciler";

export type EventName =
  | "run.created"
  | "executor.provisioning"
  | "executor.ready"
  | "agent.started"
  | "agent.tool.completed"
  | "build.failed"
  | "build.passed"
  | "browser.reproduction.completed"
  | "browser.verification.completed"
  | "branch.pushed"
  | "pr.created"
  | "ci.started"
  | "ci.failed"
  | "ci.passed"
  | "agent.ci_fix.started"
  | "review.started"
  | "review.changes_requested"
  | "agent.review_fix.started"
  | "review.approved"
  | "review.rounds_exhausted"
  | "gate.machine_passed"
  | "human.approved"
  | "approval.invalidated"
  | "merge.started"
  | "merge.succeeded"
  | "run.done"
  | "run.blocked"
  | "run.failed"
  | "run.cancelled"
  | "executor.destroyed";

// ── External-fact observations (always paired with a head SHA) ───────────────
export type CheckConclusion = "success" | "failure" | "cancelled" | "neutral" | "timed_out" | "skipped";
export interface CheckObservation {
  name: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: CheckConclusion | null;
  required: boolean;
}

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
export interface ReviewObservation {
  provider: string;
  headSha: string;
  state: ReviewState;
  round: number;
  blockingComments: number;
  submittedAt: string;
}

export type BrowserResult = "PASS" | "FAIL" | "NOT_REQUIRED";
export interface BrowserObservation {
  headSha: string;
  phase: "REPRODUCE" | "VERIFY";
  result: "PASS" | "FAIL";
  scenarioVersion: number;
  artifactIds: string[];
  at: string;
}

export type Mergeability = "UNKNOWN" | "MERGEABLE" | "CONFLICTING" | "BEHIND" | "BLOCKED";

/** Immutable, hashed snapshot recorded the instant all machine gates pass. */
export interface GateSnapshot {
  runId: string;
  headSha: string;
  ci: { status: "PASS"; checks: string[] };
  review: { status: "APPROVED"; provider: string; round: number };
  browser: { status: BrowserResult };
  mergeable: boolean;
  hash: string;
  createdAt: string;
}

export interface Approval {
  runId: string;
  approvedSha: string;
  gateHash: string;
  approverUserId: string;
  at: string;
  valid: boolean;
}

export type ExecutorStatusValue = "PROVISIONING" | "AVAILABLE" | "STOPPED" | "DESTROYED" | "FAILED";
export interface Executor {
  id: string;
  runId: string;
  provider: string;
  externalId: string | null;
  status: ExecutorStatusValue;
  createdAt: string;
  destroyedAt: string | null;
}

export interface Repository {
  id: string;
  githubRepoId: number;
  installationId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  enabled: boolean;
  /** Snapshotted from the BASE commit at run creation — never the agent head. */
  requiredChecks: string[];
}

export interface PullRequestRecord {
  runId: string;
  prNumber: number;
  headSha: string;
  branch: string;
  base: string;
  mergeable: Mergeability;
  merged: boolean;
}

// ── Outbox / queue jobs ──────────────────────────────────────────────────────
export type JobType =
  | "run.provision"
  | "run.evaluate"
  | "run.repair_ci"
  | "run.repair_review"
  | "run.repair_browser"
  | "run.merge"
  | "run.cancel"
  | "executor.destroy";

export interface OutboxMessage {
  id: string;
  jobType: JobType;
  runId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  publishedAt: string | null;
}

// ── Connectors (Linear / CodeRabbit / Greptile) ──────────────────────────────
export type ConnectorName = "linear" | "coderabbit" | "greptile";
export type ConnectorStatus = "connected" | "error" | "not_configured";
export interface ConnectorRecord {
  workspaceId: string;
  provider: ConnectorName;
  category: string;
  displayName: string;
  status: ConnectorStatus;
  accountLabel: string | null;
  /** SecretStore-encrypted; NEVER returned to clients. */
  encryptedKey: string | null;
  encryptedGithubToken: string | null;
  detail: string | null;
  lastValidatedAt: string | null;
}

export const slug = (): string =>
  // deterministic-enough unique id without a dependency
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The one branch the agent is ever allowed to push to (never a base/default branch). */
export const branchFor = (runId: string): string => `shipbot/run/${runId}`;
