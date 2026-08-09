// ─────────────────────────────────────────────────────────────────────────────
// Ports — the seams between the control plane and the outside world. The core
// logic depends only on these interfaces; real GitHub / Codespaces / Copilot /
// CodeRabbit / KMS / queue implementations plug in behind them (in-memory stubs
// ship here so the whole loop compiles + runs, exactly like the frontend's sim).
// ─────────────────────────────────────────────────────────────────────────────
import type {
  Run,
  RunEvent,
  RunSource,
  GateSnapshot,
  Approval,
  Executor,
  Repository,
  PullRequestRecord,
  OutboxMessage,
  CheckObservation,
  ReviewObservation,
  BrowserObservation,
  Mergeability,
  AttentionReason,
  RunState,
} from "./domain";

// ── Store (Postgres in prod; in-memory here). Optimistic concurrency on Run. ──
export interface RunPatch {
  state?: RunState;
  headSha?: string | null;
  branchName?: string | null;
  prNumber?: number | null;
  gateHash?: string | null;
  attentionReason?: AttentionReason | null;
  ciRepairAttempts?: number;
  reviewRound?: number;
  browserRepairAttempts?: number;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface AppendEventInput {
  runId: string;
  eventType: RunEvent["eventType"];
  source: RunEvent["source"];
  headSha?: string | null;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}

export interface Store {
  // runs
  createRun(run: Run): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  /** Optimistic update: applies only if stateVersion matches; returns null on conflict. */
  updateRun(id: string, expectedVersion: number, patch: RunPatch): Promise<Run | null>;
  listRuns(filter: { workspaceId?: string; repositoryId?: string; attentionOnly?: boolean }): Promise<Run[]>;

  // append-only event log (unique on source+idempotencyKey → idempotent)
  appendEvent(input: AppendEventInput): Promise<RunEvent | null>;
  listEvents(runId: string): Promise<RunEvent[]>;

  // transactional outbox
  publishOutbox(msg: Omit<OutboxMessage, "id" | "createdAt" | "publishedAt">): Promise<OutboxMessage>;
  claimOutbox(limit: number): Promise<OutboxMessage[]>;
  markPublished(id: string): Promise<void>;

  // webhook dedup — returns true if this delivery is new
  recordDelivery(deliveryId: string, event: string, action: string | null): Promise<boolean>;

  // gate snapshots + approvals (SHA-bound)
  saveGateSnapshot(snap: GateSnapshot): Promise<void>;
  getGateSnapshot(runId: string): Promise<GateSnapshot | null>;
  invalidateGateSnapshots(runId: string): Promise<void>;
  saveApproval(a: Approval): Promise<void>;
  getValidApproval(runId: string): Promise<Approval | null>;
  invalidateApprovals(runId: string): Promise<void>;

  // executors + PRs + repos
  saveExecutor(e: Executor): Promise<void>;
  getExecutorForRun(runId: string): Promise<Executor | null>;
  liveExecutorsForTerminalRuns(): Promise<Executor[]>;
  savePullRequest(pr: PullRequestRecord): Promise<void>;
  getPullRequest(runId: string): Promise<PullRequestRecord | null>;
  getRepository(id: string): Promise<Repository | null>;

  // runner enrollment (single-use nonce → scoped session)
  createEnrollmentNonce(runId: string): Promise<string>;
  redeemEnrollmentNonce(nonce: string): Promise<{ runId: string } | null>;
}

// ── GitHub control-plane client ──────────────────────────────────────────────
export interface ScopedTokenRequest {
  installationId: number;
  repositoryIds: number[];
  permissions: Record<string, "read" | "write">;
}
export interface ScopedToken {
  token: string;
  expiresAt: string;
}

export interface GitHubPr {
  number: number;
  headSha: string;
  base: string;
  branch: string;
  mergeable: Mergeability;
  merged: boolean;
}

export interface GitHubClient {
  /** Mint a 1-hour, repo- and permission-scoped installation token, just-in-time. */
  mintScopedInstallationToken(req: ScopedTokenRequest): Promise<ScopedToken>;
  /** Re-check that a GitHub user currently holds >= write on the repo (R8). */
  userHasWriteAccess(githubUserId: number, repo: Repository): Promise<boolean>;

  findOpenPr(repo: Repository, branch: string): Promise<GitHubPr | null>;
  createPullRequest(input: {
    repo: Repository;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<GitHubPr>;
  getPullRequest(repo: Repository, prNumber: number): Promise<GitHubPr>;

  listChecks(repo: Repository, headSha: string): Promise<CheckObservation[]>;
  listReviews(repo: Repository, prNumber: number): Promise<ReviewObservation[]>;

  /** Publish/refresh the `Shipbot / Gate` check for a head SHA. */
  publishGateCheck(
    repo: Repository,
    headSha: string,
    status: "in_progress" | "completed",
    conclusion: "success" | "failure" | "neutral" | null,
    summary: string,
  ): Promise<void>;

  /** Submit the human's approving review as the user (visible in GitHub's audit). */
  submitApprovalReview(input: { repo: Repository; prNumber: number; asGithubUserId: number }): Promise<void>;

  /** Merge, conditioned on the expected head SHA (rejects if the tip moved). */
  merge(input: { repo: Repository; prNumber: number; expectedHeadSha: string }): Promise<{ merged: boolean; sha: string | null }>;
}

// ── Execution provider (Codespaces first, hardened VM later) ──────────────────
export interface ProvisionRequest {
  runId: string;
  repo: Repository;
  baseSha: string;
  branchName: string;
  devcontainerPath?: string;
  machine?: string;
  idleTimeoutMinutes?: number;
}

export interface RunnerBootstrap {
  runId: string;
  enrollmentNonce: string;
  controlPlaneUrl: string;
  /** The frozen task manifest handed to the agent runtime (Copilot SDK). */
  manifest: TaskManifest;
}

export interface TaskManifest {
  runId: string;
  repository: string;
  baseSha: string;
  branch: string;
  task: string;
  acceptanceCriteria: string[];
  browserRequired: boolean;
  commands: { test?: string[]; build?: string[]; devStart?: string };
  rules: string[];
  promptVersion: string;
}

export interface ExecutorStatus {
  id: string;
  state: Executor["status"];
  /** True only if the environment supports the SSH bootstrap mechanism. */
  bootstrappable: boolean;
}

export interface ExecutionProvider {
  readonly name: string;
  provision(input: ProvisionRequest): Promise<Executor>;
  start(executorId: string): Promise<void>;
  execute(executorId: string, bootstrap: RunnerBootstrap): Promise<void>;
  stop(executorId: string): Promise<void>;
  destroy(executorId: string): Promise<void>;
  inspect(executorId: string): Promise<ExecutorStatus>;
}

// ── Review provider (CodeRabbit first, Greptile behind the same seam) ─────────
export interface ReviewProvider {
  readonly name: string;
  /** Ask the provider to (re)review — the source of truth is still the GitHub review. */
  trigger?(repo: Repository, prNumber: number): Promise<void>;
  isCurrent(review: ReviewObservation, headSha: string): boolean;
}

// ── Secret store (KMS-backed in prod) ─────────────────────────────────────────
export interface SecretStore {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

// ── Artifact storage (encrypted object store in prod) ────────────────────────
export interface ArtifactStore {
  put(meta: { runId: string; kind: string; contentType: string }): Promise<{ id: string; uploadUrl: string }>;
}

/** Everything the app is wired from — one place to swap stubs for real services. */
export interface Deps {
  store: Store;
  github: GitHubClient;
  execution: ExecutionProvider;
  review: ReviewProvider;
  secrets: SecretStore;
  artifacts: ArtifactStore;
  config: {
    webhookSecret: string;
    controlPlaneUrl: string;
    promptVersion: string;
  };
}

export type { CheckObservation, ReviewObservation, BrowserObservation, RunSource };
