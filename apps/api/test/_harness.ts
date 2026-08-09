// Shared test harness: an orchestrator wired to the in-memory stubs, with a
// pluggable "world" (the runner + CI + reviewer that live outside the control
// plane in prod). The default world is the green happy path; tests override
// `onPush` to inject CI failures, review changes, or head races.
import { MemoryStore } from "../src/store.memory";
import { SimGitHub } from "../src/adapters/github.stub";
import { CodespacesExecutionProvider } from "../src/adapters/execution.codespaces";
import { CodeRabbitReviewProvider } from "../src/adapters/review.coderabbit";
import { PassthroughSecrets, StubArtifacts } from "../src/adapters/misc.stub";
import { Orchestrator } from "../src/orchestrator";
import { RunService } from "../src/runService";
import { branchFor, type Repository, type CheckObservation, type Run } from "../src/domain";
import type { Deps } from "../src/ports";

export interface World {
  runId: string;
  sha: string;
  store: MemoryStore;
  github: SimGitHub;
  orchestrator: Orchestrator;
  review: CodeRabbitReviewProvider;
  repo: Repository;
}

export interface HarnessOpts {
  bootstrappable?: boolean;
  requiredChecks?: string[];
  onPush?: (w: World) => Promise<void>;
}

export function makeSystem(opts: HarnessOpts = {}) {
  const repo: Repository = {
    id: "repo_test",
    githubRepoId: 4242,
    installationId: 77,
    owner: "TayoAki",
    name: "OrbitV2",
    defaultBranch: "main",
    enabled: true,
    requiredChecks: opts.requiredChecks ?? ["build", "test"],
  };
  const store = new MemoryStore([repo]);
  const github = new SimGitHub();
  const execution = new CodespacesExecutionProvider({ bootstrappable: opts.bootstrappable ?? true });
  const review = new CodeRabbitReviewProvider();
  const deps: Deps = {
    store,
    github,
    execution,
    review,
    secrets: new PassthroughSecrets(),
    artifacts: new StubArtifacts(),
    config: { webhookSecret: "test-secret", controlPlaneUrl: "http://localhost", promptVersion: "test" },
  };
  const orchestrator = new Orchestrator(deps);
  const runService = new RunService(deps);

  execution.onRunnerPush = async (runId, sha) => {
    if (opts.onPush) return opts.onPush({ runId, sha, store, github, orchestrator, review, repo });
    await greenPush({ runId, sha, store, github, orchestrator, review, repo });
  };

  return { repo, store, github, execution, review, deps, orchestrator, runService };
}

/** The default green world: required checks pass, CodeRabbit approves → AWAITING_HUMAN. */
export async function greenPush(w: World): Promise<void> {
  const run = await w.store.getRun(w.runId);
  if (!run) return;
  const branch = run.branchName ?? branchFor(w.runId);
  w.github.pushBranch(w.repo, branch, w.sha);
  const checks: CheckObservation[] = w.repo.requiredChecks.map((name) => ({
    name,
    headSha: w.sha,
    status: "completed",
    conclusion: "success",
    required: true,
  }));
  w.github.setChecks(w.repo, w.sha, checks);
  await w.orchestrator.onBranchPushed(w.runId, w.sha);
  const fresh = await w.store.getRun(w.runId);
  if (fresh?.prNumber != null) {
    w.github.setReview(w.repo, fresh.prNumber, {
      provider: w.review.name,
      headSha: w.sha,
      state: "APPROVED",
      round: 1,
      blockingComments: 0,
      submittedAt: new Date().toISOString(),
    });
    if (run.acceptanceCriteria.browserRequired) await w.orchestrator.onBrowserResult(w.runId, w.sha, "VERIFY", "PASS");
    await w.orchestrator.evaluate(w.runId);
  }
}

/** Poll until a run reaches one of the target states (or time out). */
export async function waitForState(store: MemoryStore, runId: string, states: Run["state"][], timeoutMs = 2000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await store.getRun(runId);
    if (run && states.includes(run.state)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not reach ${states.join("|")}; stuck at ${run?.state}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
