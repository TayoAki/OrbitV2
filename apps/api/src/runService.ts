// ─────────────────────────────────────────────────────────────────────────────
// RunService — the one write path that creates a Run, plus the read projections
// the frontend needs (board list, inbox = attention query, run + event log).
// createRun does NOT provision inline; it writes the run + a transactional-outbox
// job, and the pump hands provisioning to the orchestrator. (Blueprint: "one
// createRun entry point"; "never do slow work in the request".)
// ─────────────────────────────────────────────────────────────────────────────
import type { Deps } from "./ports";
import type { Run, RunEvent, RunSource, ExecutionMode, AcceptanceCriteria } from "./domain";
import { slug } from "./domain";

export interface CreateRunInput {
  workspaceId: string;
  repositoryId: string;
  creatorUserId: string;
  title: string;
  instructions: string;
  acceptanceCriteria?: Partial<AcceptanceCriteria>;
  source?: RunSource;
  executionMode?: ExecutionMode;
  /** Base commit to branch from; defaults to the repo's snapshotted base. */
  baseSha?: string;
  baseRef?: string;
}

export class RunService {
  constructor(private deps: Deps) {}

  async createRun(input: CreateRunInput): Promise<Run> {
    const repo = await this.deps.store.getRepository(input.repositoryId);
    if (!repo) throw new HttpError(404, "repository not found");
    if (!repo.enabled) throw new HttpError(409, "repository not enabled");

    const now = new Date().toISOString();
    const run: Run = {
      id: `run_${slug()}`,
      workspaceId: input.workspaceId,
      repositoryId: repo.id,
      creatorUserId: input.creatorUserId,
      source: input.source ?? { type: "BOARD" },
      title: input.title,
      instructions: input.instructions,
      acceptanceCriteria: {
        criteria: input.acceptanceCriteria?.criteria ?? [],
        browserRequired: input.acceptanceCriteria?.browserRequired ?? false,
      },
      executionMode: input.executionMode ?? "SUPERVISED",
      state: "QUEUED",
      stateVersion: 0,
      baseRef: input.baseRef ?? repo.defaultBranch,
      // Base is snapshotted at creation and frozen; required checks + security config
      // are taken from BASE, never from the agent's head. (Blueprint R7.)
      baseSha: input.baseSha ?? `base_${slug()}`,
      branchName: null,
      headSha: null,
      prNumber: null,
      ciRepairAttempts: 0,
      reviewRound: 0,
      browserRepairAttempts: 0,
      gateHash: null,
      attentionReason: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    };

    await this.deps.store.createRun(run);
    await this.deps.store.appendEvent({
      runId: run.id,
      eventType: "run.created",
      source: run.source.type === "BOARD" || run.source.type === "API" ? "human" : "github",
      idempotencyKey: `created:${run.id}`,
      payload: { title: run.title, source: run.source },
    });
    // Hand provisioning to the orchestrator via the outbox (survives a crash here).
    await this.deps.store.publishOutbox({ jobType: "run.provision", runId: run.id, payload: {} });
    return run;
  }

  async getRun(id: string): Promise<{ run: Run; events: RunEvent[] } | null> {
    const run = await this.deps.store.getRun(id);
    if (!run) return null;
    const events = await this.deps.store.listEvents(id);
    return { run, events };
  }

  listRuns(repositoryId?: string, workspaceId?: string): Promise<Run[]> {
    return this.deps.store.listRuns({ repositoryId, workspaceId });
  }

  /** The inbox is exactly "runs that need a human", i.e. attentionReason set. */
  inbox(workspaceId?: string): Promise<Run[]> {
    return this.deps.store.listRuns({ workspaceId, attentionOnly: true });
  }

  /** Reverse lookup used by the webhook handler to find the affected run. */
  async findRunByPr(repositoryId: string, prNumber: number): Promise<Run | null> {
    const runs = await this.deps.store.listRuns({ repositoryId });
    return runs.find((r) => r.prNumber === prNumber && !["DONE", "FAILED", "CANCELLED"].includes(r.state)) ?? null;
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
