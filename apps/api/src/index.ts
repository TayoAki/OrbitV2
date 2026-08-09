// ─────────────────────────────────────────────────────────────────────────────
// Composition root — wires the in-memory stubs into the real orchestrator and
// starts the HTTP server + outbox pump. Swapping in Postgres / real GitHub /
// Codespaces / CodeRabbit is a matter of replacing the four constructors below;
// nothing above this file changes. Same philosophy as apps/web's sim engine.
// ─────────────────────────────────────────────────────────────────────────────
import type { Deps } from "./ports";
import type { Repository, CheckObservation } from "./domain";
import { branchFor } from "./domain";
import { MemoryStore } from "./store.memory";
import { SimGitHub } from "./adapters/github.stub";
import { CodespacesExecutionProvider } from "./adapters/execution.codespaces";
import { CodeRabbitReviewProvider } from "./adapters/review.coderabbit";
import { PassthroughSecrets, StubArtifacts } from "./adapters/misc.stub";
import { Orchestrator } from "./orchestrator";
import { RunService } from "./runService";
import { createHttpServer } from "./http";

export function buildSystem(repos: Repository[]) {
  const store = new MemoryStore(repos);
  const github = new SimGitHub();
  const execution = new CodespacesExecutionProvider({ bootstrappable: true });
  const review = new CodeRabbitReviewProvider();
  const deps: Deps = {
    store,
    github,
    execution,
    review,
    secrets: new PassthroughSecrets(),
    artifacts: new StubArtifacts(),
    config: {
      webhookSecret: process.env.SHIPBOT_WEBHOOK_SECRET ?? "dev-webhook-secret",
      controlPlaneUrl: process.env.SHIPBOT_CONTROL_URL ?? "http://localhost:8787",
      promptVersion: "2026-08-08",
    },
  };
  const orchestrator = new Orchestrator(deps);
  const runService = new RunService(deps);
  const byGithubId = new Map(repos.map((r) => [r.githubRepoId, r.id] as const));
  const resolveRepositoryId = async (githubRepoId: number) => byGithubId.get(githubRepoId) ?? null;

  // ── DEMO WORLD ──────────────────────────────────────────────────────────────
  // Model the runner + CI + reviewer that, in prod, live outside the control plane
  // and report via the runner API and webhooks. On each push we green the required
  // checks and (once the PR exists) record a CodeRabbit approval — so a created run
  // flows QUEUED → … → AWAITING_HUMAN on its own, ready for a human to approve.
  execution.onRunnerPush = async (runId, sha) => {
    const run = await store.getRun(runId);
    if (!run) return;
    const repo = await store.getRepository(run.repositoryId);
    if (!repo) return;
    const branch = run.branchName ?? branchFor(runId);
    github.pushBranch(repo, branch, sha);
    const checks: CheckObservation[] = repo.requiredChecks.map((name) => ({
      name,
      headSha: sha,
      status: "completed",
      conclusion: "success",
      required: true,
    }));
    github.setChecks(repo, sha, checks);
    await orchestrator.onBranchPushed(runId, sha); // opens PR, CI green → REVIEWING (awaits review)

    const fresh = await store.getRun(runId);
    if (fresh?.prNumber != null) {
      github.setReview(repo, fresh.prNumber, {
        provider: review.name,
        headSha: sha,
        state: "APPROVED",
        round: 1,
        blockingComments: 0,
        submittedAt: new Date().toISOString(),
      });
      if (run.acceptanceCriteria.browserRequired) {
        await orchestrator.onBrowserResult(runId, sha, "VERIFY", "PASS");
      }
      await orchestrator.evaluate(runId); // review present → VERIFYING → AWAITING_HUMAN
    }
  };

  return { deps, store, github, execution, review, orchestrator, runService, resolveRepositoryId };
}

/** Drain the transactional outbox into the orchestrator (the async job pump). */
export function startPump(system: ReturnType<typeof buildSystem>, intervalMs = 200): () => void {
  const { deps, orchestrator } = system;
  let running = false;
  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const jobs = await deps.store.claimOutbox(16);
      for (const job of jobs) {
        try {
          if (job.jobType === "run.provision") await orchestrator.provision(job.runId);
          else if (job.jobType === "run.evaluate") await orchestrator.evaluate(job.runId);
        } catch (err) {
          console.error(`[pump] ${job.jobType} ${job.runId} failed:`, (err as Error).message);
        } finally {
          await deps.store.markPublished(job.id);
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void drain(), intervalMs);
  return () => clearInterval(timer);
}

function seedRepository(): Repository {
  return {
    id: "repo_demo",
    githubRepoId: 424242,
    installationId: 9999,
    owner: "TayoAki",
    name: "OrbitV2",
    defaultBranch: "main",
    enabled: true,
    requiredChecks: ["build", "test"], // snapshotted from BASE in prod
  };
}

// ── main ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const system = buildSystem([seedRepository()]);
  const stopPump = startPump(system);
  const server = createHttpServer(system);
  const port = Number(process.env.PORT ?? 8787);
  server.listen(port, () => {
    console.log(`shipbot control plane listening on :${port}`);
    console.log(`  POST /v1/runs                     create a run (→ provisions + ships)`);
    console.log(`  GET  /v1/runs?repositoryId=…       board list`);
    console.log(`  GET  /v1/inbox                    runs awaiting a human`);
    console.log(`  GET  /v1/runs/:id                 run + event log`);
    console.log(`  GET  /v1/runs/:id/events          SSE event stream`);
    console.log(`  POST /v1/runs/:id/approve         approve + merge (SHA-bound)`);
    console.log(`  POST /v1/runs/:id/cancel          cancel a run`);
    console.log(`  POST /v1/webhooks/github          signed GitHub webhooks`);
    console.log(`  seed repo: ${seedRepository().owner}/${seedRepository().name} (id=repo_demo)`);
  });
  const shutdown = () => {
    stopPump();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
