// ─────────────────────────────────────────────────────────────────────────────
// GitHubCodespacesProvider (skeleton). Implements the ExecutionProvider port.
//
// ARCHITECTURAL CORRECTION baked in (per the blueprint):
// A Codespace CANNOT provide "the agent only has our push-only token." GitHub
// injects its OWN repository token into a write-authorized user's Codespace, and a
// repo's devcontainer.json can execute arbitrary code. So: this provider is behind
// the ExecutionProvider seam, the Run state machine is NOT coupled to it, and we
// never MARKET a cryptographic one-credential boundary for it. A future
// HardenedVmProvider (Dev Container CLI on an owned microVM) can make that claim
// literally true — and swaps in without touching the rest of the app.
//
// Real impl notes:
//  • create via the Codespaces REST API with a GitHub App USER access token
//    (not the installation token) + Codespaces:write; pass the pinned base ref
//    and devcontainer_path.
//  • there is NO REST exec endpoint — bootstrap via `gh codespace ssh -- <cmd>`,
//    which requires an SSH server in the image; if absent, fail EXECUTOR_INCOMPATIBLE.
//  • stop while waiting, delete at terminal state (the reconciler enforces this).
// ─────────────────────────────────────────────────────────────────────────────
import type { ExecutionProvider, ProvisionRequest, RunnerBootstrap, ExecutorStatus } from "../ports";
import type { Executor } from "../domain";
import { slug } from "../domain";

interface Opts {
  /** Model an image lacking an SSH server → EXECUTOR_INCOMPATIBLE. */
  bootstrappable?: boolean;
}

export class CodespacesExecutionProvider implements ExecutionProvider {
  readonly name = "github-codespaces";
  /** Wired by index to the orchestrator; models the runner pushing a commit. */
  onRunnerPush?: (runId: string, headSha: string) => void;

  private executors = new Map<string, { status: Executor["status"]; runId: string; bootstrappable: boolean }>();
  private pushSeq = 0; // monotonic → each simulated commit gets a distinct SHA

  constructor(private opts: Opts = {}) {}

  async provision(input: ProvisionRequest): Promise<Executor> {
    const id = `exec_${slug()}`;
    this.executors.set(id, { status: "PROVISIONING", runId: input.runId, bootstrappable: this.opts.bootstrappable ?? true });
    return {
      id,
      runId: input.runId,
      provider: this.name,
      externalId: `cs_${input.runId.slice(0, 8)}_${slug().slice(0, 6)}`,
      status: "PROVISIONING",
      createdAt: new Date().toISOString(),
      destroyedAt: null,
    };
  }

  async start(executorId: string): Promise<void> {
    const e = this.executors.get(executorId);
    if (e) e.status = "AVAILABLE";
  }

  async execute(executorId: string, bootstrap: RunnerBootstrap): Promise<void> {
    const e = this.executors.get(executorId);
    if (!e) throw new Error("unknown executor");
    if (!e.bootstrappable) {
      const err = new Error("EXECUTOR_INCOMPATIBLE: no SSH server for bootstrap");
      (err as { code?: string }).code = "EXECUTOR_INCOMPATIBLE";
      throw err;
    }
    // Simulate: the Shipbot Runner (with the Copilot SDK) edits/tests, then pushes
    // shipbot/run/<id> using a just-in-time single-repo contents-write credential.
    // Each execute (initial build or a repair) must yield a DISTINCT commit — a
    // repeated SHA would be (correctly) deduped by the orchestrator and stall repairs.
    const headSha = pseudoSha(`${bootstrap.runId}:${(this.pushSeq += 1)}`);
    queueMicrotask(() => this.onRunnerPush?.(bootstrap.runId, headSha));
  }

  async stop(executorId: string): Promise<void> {
    const e = this.executors.get(executorId);
    if (e) e.status = "STOPPED";
  }

  async destroy(executorId: string): Promise<void> {
    const e = this.executors.get(executorId);
    if (e) e.status = "DESTROYED";
  }

  async inspect(executorId: string): Promise<ExecutorStatus> {
    const e = this.executors.get(executorId);
    return { id: executorId, state: e?.status ?? "FAILED", bootstrappable: e?.bootstrappable ?? false };
  }
}

function pseudoSha(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(7, "0").slice(0, 7);
}
