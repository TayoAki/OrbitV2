// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator — the control-plane authority. It owns every Run transition; the
// executor, GitHub, and review provider are untrusted/observed inputs. Invariants
// enforced here (blueprint §"security model"):
//   • The agent only ever commits+pushes to shipbot/run/<id>. PR creation and merge
//     are control-plane-only actions, done with the control identity — never the
//     credential handed to the executor.
//   • Every external transition is SHA-bound. A result for SHA A never advances B.
//   • Merge is conditioned on expectedHeadSha; a moved tip invalidates the approval.
//   • Repair budgets are hard money ceilings; exhaustion escalates, never loops.
//   • Per-run work is serialized (models SELECT … FOR UPDATE) so two events can't
//     interleave a transition.
// ─────────────────────────────────────────────────────────────────────────────
import type { Deps, RunPatch } from "./ports";
import type { Run, RunState, AttentionReason, EventName, EventSource, GateSnapshot, Repository } from "./domain";
import { branchFor, canTransition, isTerminal, CANCELLABLE_STATES, CAPS } from "./domain";
import { computeRequiredCi, computeReview, computeBrowser, buildGateSnapshot } from "./gate";

const SYSTEM_PRINCIPAL = "system:autonomous";

export interface ApproveInput {
  runId: string;
  approverUserId: string;
  approverGithubUserId: number;
}
export type ApproveResult =
  | { ok: true }
  | { ok: false; reason: "NOT_AWAITING" | "NO_WRITE_ACCESS" | "GATE_STALE" | "HEAD_MOVED" };

export class Orchestrator {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private deps: Deps) {}

  // ── public entrypoints (each acquires the per-run lock) ─────────────────────
  provision(runId: string): Promise<void> {
    return this.withLock(runId, () => this.provisionLocked(runId));
  }
  onBranchPushed(runId: string, headSha: string): Promise<void> {
    return this.withLock(runId, () => this.branchPushedLocked(runId, headSha));
  }
  evaluate(runId: string): Promise<void> {
    return this.withLock(runId, () => this.evaluateLocked(runId));
  }
  approve(input: ApproveInput): Promise<ApproveResult> {
    return this.withLock(input.runId, () => this.approveLocked(input));
  }
  cancel(runId: string, userId: string): Promise<boolean> {
    return this.withLock(runId, () => this.cancelLocked(runId, userId));
  }
  /** Runner reports a browser reproduce/verify result; SHA-bound, then re-evaluate. */
  onBrowserResult(runId: string, headSha: string, phase: "REPRODUCE" | "VERIFY", result: "PASS" | "FAIL"): Promise<void> {
    return this.withLock(runId, async () => {
      const run = await this.deps.store.getRun(runId);
      if (!run) return;
      await this.deps.store.appendEvent({
        runId,
        eventType: "browser.verification.completed",
        source: "runner",
        headSha,
        idempotencyKey: `browser:${phase}:${headSha}`,
        payload: { phase, result },
      });
      await this.evaluateLocked(runId);
    });
  }

  // ── provision: QUEUED → PROVISIONING → BUILDING ─────────────────────────────
  private async provisionLocked(runId: string): Promise<void> {
    let run = await this.deps.store.getRun(runId);
    if (!run || run.state !== "QUEUED") return;
    const repo = await this.repo(run);
    const branch = branchFor(run.id);

    // Control plane mints a just-in-time, single-repo, short-lived contents:write
    // credential. The App private key NEVER enters the executor; this token is the
    // only thing the runner gets, and it is discarded after the push. (Not a
    // "push-only token" — it is a single-repository short-lived contents-write cred.)
    const scoped = await this.deps.github.mintScopedInstallationToken({
      installationId: repo.installationId,
      repositoryIds: [repo.githubRepoId],
      permissions: { contents: "write" },
    });
    const nonce = await this.deps.store.createEnrollmentNonce(run.id);

    run = await this.set(run, "PROVISIONING", { branchName: branch, startedAt: new Date().toISOString() }, {
      type: "executor.provisioning",
      source: "control_plane",
      key: `provisioning:${run.id}`,
    });

    const executor = await this.deps.execution.provision({ runId: run.id, repo, baseSha: run.baseSha, branchName: branch });
    await this.deps.store.saveExecutor(executor);
    await this.deps.execution.start(executor.id);

    const status = await this.deps.execution.inspect(executor.id);
    if (!status.bootstrappable) {
      // e.g. a Codespace image without an SSH server → cannot bootstrap the runner.
      await this.blockLocked(run, "EXECUTOR_INCOMPATIBLE", { reason: "no bootstrap mechanism" });
      return;
    }
    await this.deps.store.saveExecutor({ ...executor, status: "AVAILABLE" });

    run = await this.set(run, "BUILDING", {}, { type: "executor.ready", source: "control_plane", key: `ready:${run.id}` });
    await this.deps.store.appendEvent({
      runId: run.id,
      eventType: "agent.started",
      source: "control_plane",
      idempotencyKey: `agent-started:${run.id}`,
      payload: { promptVersion: this.deps.config.promptVersion },
    });

    try {
      await this.deps.execution.execute(executor.id, {
        runId: run.id,
        enrollmentNonce: nonce,
        controlPlaneUrl: this.deps.config.controlPlaneUrl,
        manifest: {
          runId: run.id,
          repository: `${repo.owner}/${repo.name}`,
          baseSha: run.baseSha,
          branch,
          task: run.instructions,
          acceptanceCriteria: run.acceptanceCriteria.criteria,
          browserRequired: run.acceptanceCriteria.browserRequired,
          commands: {},
          rules: [
            "Only commit and push to the assigned branch.",
            "Never open or merge the pull request.",
            "Never read or exfiltrate control-plane secrets.",
          ],
          promptVersion: this.deps.config.promptVersion,
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EXECUTOR_INCOMPATIBLE") {
        await this.blockLocked(run, "EXECUTOR_INCOMPATIBLE", { reason: String((err as Error).message) });
        return;
      }
      await this.failLocked(run, { reason: "executor.execute failed", detail: String((err as Error).message) });
    }
    // Voided: the scoped token is intentionally not retained past this point.
    void scoped;
  }

  // ── a branch push (first build OR a repair commit) lands here ───────────────
  private async branchPushedLocked(runId: string, headSha: string): Promise<void> {
    let run = await this.deps.store.getRun(runId);
    if (!run || isTerminal(run.state)) return;
    if (run.headSha === headSha) return; // idempotent: same commit reported twice
    const repo = await this.repo(run);
    const branch = run.branchName ?? branchFor(run.id);

    // Head moved → any prior gate snapshot / approval is now stale.
    await this.deps.store.invalidateGateSnapshots(run.id);
    await this.deps.store.invalidateApprovals(run.id);

    run = await this.patch(run, { headSha, branchName: branch, gateHash: null });
    await this.deps.store.appendEvent({
      runId: run.id,
      eventType: "branch.pushed",
      source: "runner",
      headSha,
      idempotencyKey: `push:${headSha}`,
      payload: { branch },
    });

    if (run.state === "BUILDING" || run.state === "PROVISIONING") {
      // First push → open (or adopt) the PR with the CONTROL identity, then gate.
      run = await this.set(run, "PR_OPEN", {}, { type: "build.passed", source: "runner", key: `build-passed:${headSha}` });
      const existing = await this.deps.github.findOpenPr(repo, branch);
      const pr = existing ?? (await this.deps.github.createPullRequest({
        repo,
        head: branch,
        base: run.baseRef,
        title: run.title,
        body: `Shipbot run ${run.id}\n\n${run.instructions}`,
      }));
      await this.deps.store.savePullRequest({
        runId: run.id,
        prNumber: pr.number,
        headSha: pr.headSha,
        branch,
        base: pr.base,
        mergeable: pr.mergeable,
        merged: pr.merged,
      });
      run = await this.patch(run, { prNumber: pr.number });
      await this.deps.store.appendEvent({
        runId: run.id,
        eventType: "pr.created",
        source: "control_plane",
        headSha,
        idempotencyKey: `pr-created:${run.id}`,
        payload: { prNumber: pr.number },
      });
      run = await this.set(run, "CI_WAIT", {}, { type: "ci.started", source: "github", key: `ci-wait:${headSha}` });
    } else if (run.state === "FIXING_CI" || run.state === "FIXING_REVIEW" || run.state === "FIXING_BROWSER") {
      run = await this.set(run, "CI_WAIT", {}, { type: "ci.started", source: "github", key: `ci-wait:${headSha}` });
    } else if (run.state === "AWAITING_HUMAN") {
      // A late push after we thought we were ready → re-gate the new SHA.
      run = await this.set(run, "CI_WAIT", { attentionReason: null }, { type: "approval.invalidated", source: "control_plane", key: `reopen:${headSha}` });
    }

    await this.evaluateLocked(run.id);
  }

  // ── the idempotent, SHA-bound gate loop ─────────────────────────────────────
  private async evaluateLocked(runId: string): Promise<void> {
    let run = await this.deps.store.getRun(runId);
    if (!run || isTerminal(run.state)) return;
    if (run.prNumber == null || run.headSha == null) return; // nothing to gate yet
    const repo = await this.repo(run);

    // Reconcile head: if GitHub's PR head is ahead of what we recorded, resync +
    // reset to CI_WAIT before doing anything (never gate a stale SHA).
    const prNumber = run.prNumber;
    const pr = await this.deps.github.getPullRequest(repo, prNumber);
    if (pr.headSha !== run.headSha) {
      await this.deps.store.invalidateGateSnapshots(run.id);
      await this.deps.store.invalidateApprovals(run.id);
      run = await this.patch(run, { headSha: pr.headSha, gateHash: null });
      if (run.state !== "CI_WAIT" && canTransition(run.state, "CI_WAIT")) {
        run = await this.set(run, "CI_WAIT", { attentionReason: null }, { type: "approval.invalidated", source: "control_plane", key: `resync:${pr.headSha}` });
      }
    }
    const headSha = run.headSha!;

    const ci = await computeRequiredCi(this.deps, repo, headSha);
    const rev = await computeReview(this.deps, repo, prNumber, headSha);
    const br = await computeBrowser(this.deps, run, headSha);

    // stage 1 — required CI
    if (run.state === "CI_WAIT") {
      if (!ci.complete) return; // wait for checks to report
      if (ci.failed) return this.repairCi(run, ci.failedChecks);
      run = await this.set(run, "REVIEWING", {}, {
        type: "ci.passed",
        source: "github",
        headSha,
        key: `ci-passed:${headSha}`,
        payload: { checks: ci.passedChecks },
      });
    }

    // stage 2 — machine review
    if (run.state === "REVIEWING") {
      if (rev.changesRequested) return this.repairReview(run);
      if (!rev.approved) return; // wait for the reviewer
      run = await this.set(run, "VERIFYING", {}, {
        type: "review.approved",
        source: "review_provider",
        headSha,
        key: `review-approved:${headSha}:${rev.round}`,
        payload: { provider: rev.provider, round: rev.round },
      });
    }

    // stage 3 — browser verification + mergeability, then snapshot the gate
    if (run.state === "VERIFYING") {
      if (br.required && (await this.browserFailedAt(run.id, headSha))) return this.repairBrowser(run);
      if (br.required && !br.passed) return; // wait for the verify pass
      const fresh = await this.deps.github.getPullRequest(repo, prNumber);
      if (fresh.headSha !== headSha) return; // moved mid-evaluation → a push event will re-drive
      if (fresh.mergeable !== "MERGEABLE") return; // wait for mergeable

      const snapshot = buildGateSnapshot({
        runId: run.id,
        headSha,
        ciChecks: ci.passedChecks,
        reviewProvider: rev.provider,
        reviewRound: rev.round,
        browser: br,
        mergeable: true,
      });
      await this.deps.store.saveGateSnapshot(snapshot);
      await this.deps.github.publishGateCheck(repo, headSha, "completed", "success", "All machine gates satisfied");
      run = await this.set(run, "AWAITING_HUMAN", { gateHash: snapshot.hash, attentionReason: "READY_TO_MERGE" }, {
        type: "gate.machine_passed",
        source: "control_plane",
        headSha,
        key: `gate:${snapshot.hash}`,
        payload: { gateHash: snapshot.hash },
      });

      // Supervised is the default. Autonomy is a durable server-side policy — here
      // modeled by executionMode — and is re-validated at merge, never trusted from
      // a prompt or a repo-editable file.
      if (run.executionMode === "AUTONOMOUS") {
        await this.mergeLocked(run, snapshot, SYSTEM_PRINCIPAL, null);
      }
    }
  }

  // ── repairs (bounded) ───────────────────────────────────────────────────────
  private async repairCi(run: Run, failedChecks: string[]): Promise<void> {
    if (run.ciRepairAttempts >= CAPS.CI_REPAIR_MAX) {
      return this.blockLocked(run, "AUTOMATION_EXHAUSTED", { stage: "ci", failedChecks });
    }
    const next = await this.set(run, "FIXING_CI", { ciRepairAttempts: run.ciRepairAttempts + 1 }, {
      type: "agent.ci_fix.started",
      source: "control_plane",
      key: `ci-fix:${run.headSha}:${run.ciRepairAttempts + 1}`,
      payload: { failedChecks },
    });
    await this.requestNewCommit(next);
  }
  private async repairReview(run: Run): Promise<void> {
    if (run.reviewRound >= CAPS.REVIEW_ROUNDS_MAX) {
      await this.deps.store.appendEvent({
        runId: run.id,
        eventType: "review.rounds_exhausted",
        source: "control_plane",
        headSha: run.headSha,
        idempotencyKey: `review-exhausted:${run.id}`,
        payload: { rounds: run.reviewRound },
      });
      return this.blockLocked(run, "AUTOMATION_EXHAUSTED", { stage: "review", rounds: run.reviewRound });
    }
    const next = await this.set(run, "FIXING_REVIEW", { reviewRound: run.reviewRound + 1 }, {
      type: "agent.review_fix.started",
      source: "control_plane",
      key: `review-fix:${run.headSha}:${run.reviewRound + 1}`,
    });
    await this.requestNewCommit(next);
  }
  private async repairBrowser(run: Run): Promise<void> {
    if (run.browserRepairAttempts >= CAPS.BROWSER_REPAIR_MAX) {
      return this.blockLocked(run, "AUTOMATION_EXHAUSTED", { stage: "browser" });
    }
    const next = await this.set(run, "FIXING_BROWSER", { browserRepairAttempts: run.browserRepairAttempts + 1 }, {
      type: "agent.review_fix.started",
      source: "control_plane",
      key: `browser-fix:${run.headSha}:${run.browserRepairAttempts + 1}`,
      payload: { stage: "browser" },
    });
    await this.requestNewCommit(next);
  }
  /** Ask the (already-provisioned) executor to produce a new commit for the fix. */
  private async requestNewCommit(run: Run): Promise<void> {
    const executor = await this.deps.store.getExecutorForRun(run.id);
    if (!executor) return this.failLocked(run, { reason: "no executor for repair" });
    const repo = await this.repo(run);
    const nonce = await this.deps.store.createEnrollmentNonce(run.id);
    await this.deps.execution.execute(executor.id, {
      runId: run.id,
      enrollmentNonce: nonce,
      controlPlaneUrl: this.deps.config.controlPlaneUrl,
      manifest: {
        runId: run.id,
        repository: `${repo.owner}/${repo.name}`,
        baseSha: run.baseSha,
        branch: run.branchName ?? branchFor(run.id),
        task: run.instructions,
        acceptanceCriteria: run.acceptanceCriteria.criteria,
        browserRequired: run.acceptanceCriteria.browserRequired,
        commands: {},
        rules: ["Only commit and push to the assigned branch."],
        promptVersion: this.deps.config.promptVersion,
      },
    });
  }

  // ── the human approval transaction ──────────────────────────────────────────
  private async approveLocked(input: ApproveInput): Promise<ApproveResult> {
    const run = await this.deps.store.getRun(input.runId);
    if (!run || run.state !== "AWAITING_HUMAN") return { ok: false, reason: "NOT_AWAITING" };
    const repo = await this.repo(run);

    // R8 — re-check the human currently holds write on the repo, right now.
    const hasWrite = await this.deps.github.userHasWriteAccess(input.approverGithubUserId, repo);
    if (!hasWrite) return { ok: false, reason: "NO_WRITE_ACCESS" };

    const snap = await this.deps.store.getGateSnapshot(run.id);
    if (!snap || snap.hash !== run.gateHash) return { ok: false, reason: "GATE_STALE" };

    // The head must still equal the SHA the gate (and thus the human) approved.
    const pr = await this.deps.github.getPullRequest(repo, run.prNumber!);
    if (pr.headSha !== snap.headSha) {
      await this.deps.store.invalidateGateSnapshots(run.id);
      await this.deps.store.invalidateApprovals(run.id);
      const reopened = await this.set(run, "CI_WAIT", { gateHash: null, attentionReason: null }, {
        type: "approval.invalidated",
        source: "control_plane",
        key: `approve-headmoved:${pr.headSha}`,
      });
      this.schedule(() => this.evaluate(reopened.id));
      return { ok: false, reason: "HEAD_MOVED" };
    }

    await this.deps.store.saveApproval({
      runId: run.id,
      approvedSha: snap.headSha,
      gateHash: snap.hash,
      approverUserId: input.approverUserId,
      at: new Date().toISOString(),
      valid: true,
    });
    await this.deps.store.appendEvent({
      runId: run.id,
      eventType: "human.approved",
      source: "human",
      headSha: snap.headSha,
      idempotencyKey: `approved:${snap.hash}`,
      payload: { approverUserId: input.approverUserId, gateHash: snap.hash },
    });
    // Record the approval in GitHub's own audit surface, as the user.
    await this.deps.github.submitApprovalReview({ repo, prNumber: run.prNumber!, asGithubUserId: input.approverGithubUserId });

    await this.mergeLocked(run, snap, input.approverUserId, input.approverGithubUserId);
    return { ok: true };
  }

  // ── merge, conditioned on the approved SHA ──────────────────────────────────
  private async mergeLocked(run: Run, snap: GateSnapshot, approverUserId: string, _githubUserId: number | null): Promise<void> {
    const repo = await this.repo(run);
    let cur = await this.set(run, "MERGING", {}, { type: "merge.started", source: "control_plane", headSha: snap.headSha, key: `merge-start:${snap.hash}` });

    const res = await this.deps.github.merge({ repo, prNumber: cur.prNumber!, expectedHeadSha: snap.headSha });
    if (!res.merged) {
      // The tip moved (or became unmergeable) between approval and merge — the race
      // guard fired. Invalidate, drop back to re-gating; NEVER merge a stale SHA.
      await this.deps.store.invalidateGateSnapshots(cur.id);
      await this.deps.store.invalidateApprovals(cur.id);
      cur = await this.set(cur, "AWAITING_HUMAN", {}, { type: "approval.invalidated", source: "control_plane", key: `merge-refused:${snap.hash}` });
      cur = await this.set(cur, "CI_WAIT", { gateHash: null, attentionReason: null }, { type: "ci.started", source: "control_plane", key: `merge-refused-reopen:${snap.hash}` });
      this.schedule(() => this.evaluate(cur.id));
      return;
    }

    // INVARIANT ALARM: a merge must correspond to a valid gate snapshot for exactly
    // the merged SHA. If this ever fails it is a security incident, not a bug.
    if (res.sha !== snap.headSha) {
      await this.deps.store.appendEvent({
        runId: cur.id,
        eventType: "run.failed",
        source: "control_plane",
        idempotencyKey: `invariant-alarm:${cur.id}`,
        payload: { alarm: "merged_sha_without_matching_gate", mergedSha: res.sha, gateSha: snap.headSha },
      });
    }
    await this.deps.store.appendEvent({
      runId: cur.id,
      eventType: "merge.succeeded",
      source: "github",
      headSha: res.sha,
      idempotencyKey: `merged:${res.sha}`,
      payload: { approverUserId },
    });
    cur = await this.set(cur, "DONE", { completedAt: new Date().toISOString(), attentionReason: null }, {
      type: "run.done",
      source: "control_plane",
      headSha: res.sha,
      key: `done:${cur.id}`,
    });
    await this.teardownExecutor(cur);
  }

  // ── cancel / block / fail ───────────────────────────────────────────────────
  private async cancelLocked(runId: string, userId: string): Promise<boolean> {
    const run = await this.deps.store.getRun(runId);
    if (!run || !CANCELLABLE_STATES.has(run.state)) return false;
    const done = await this.set(run, "CANCELLED", { completedAt: new Date().toISOString(), attentionReason: null }, {
      type: "run.cancelled",
      source: "human",
      key: `cancelled:${run.id}`,
      payload: { userId },
    });
    await this.teardownExecutor(done);
    return true;
  }
  private async blockLocked(run: Run, reason: AttentionReason, payload: Record<string, unknown>): Promise<void> {
    if (!canTransition(run.state, "BLOCKED")) {
      // e.g. PROVISIONING has no BLOCKED edge → fail instead.
      return this.failLocked(run, { reason, ...payload });
    }
    const blocked = await this.set(run, "BLOCKED", { attentionReason: reason }, {
      type: "run.blocked",
      source: "control_plane",
      key: `blocked:${run.id}:${run.stateVersion}`,
      payload: { reason, ...payload },
    });
    const ex = await this.deps.store.getExecutorForRun(blocked.id);
    if (ex && ex.status !== "DESTROYED") await this.deps.execution.stop(ex.id); // stop, keep for debug
  }
  private async failLocked(run: Run, payload: Record<string, unknown>): Promise<void> {
    if (!canTransition(run.state, "FAILED")) return;
    const failed = await this.set(run, "FAILED", { completedAt: new Date().toISOString(), attentionReason: "EXTERNAL_SERVICE_FAILED" }, {
      type: "run.failed",
      source: "control_plane",
      key: `failed:${run.id}:${run.stateVersion}`,
      payload,
    });
    await this.teardownExecutor(failed);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  private async teardownExecutor(run: Run): Promise<void> {
    const ex = await this.deps.store.getExecutorForRun(run.id);
    if (!ex || ex.status === "DESTROYED") return;
    await this.deps.execution.destroy(ex.id);
    await this.deps.store.saveExecutor({ ...ex, status: "DESTROYED", destroyedAt: new Date().toISOString() });
    await this.deps.store.appendEvent({
      runId: run.id,
      eventType: "executor.destroyed",
      source: "control_plane",
      idempotencyKey: `executor-destroyed:${run.id}`,
      payload: {},
    });
  }
  private async browserFailedAt(runId: string, headSha: string): Promise<boolean> {
    const events = await this.deps.store.listEvents(runId);
    return events.some((e) => e.eventType === "browser.verification.completed" && e.headSha === headSha && e.payload["result"] === "FAIL");
  }
  private async repo(run: Run): Promise<Repository> {
    const r = await this.deps.store.getRepository(run.repositoryId);
    if (!r) throw new Error(`repository ${run.repositoryId} not found`);
    return r;
  }

  /** Transition + optimistic write + audit event, all inside the held lock. */
  private async set(
    run: Run,
    to: RunState,
    patch: RunPatch,
    ev: { type: EventName; source: EventSource; headSha?: string | null; key: string; payload?: Record<string, unknown> },
  ): Promise<Run> {
    if (!canTransition(run.state, to)) throw new Error(`illegal transition ${run.state} → ${to}`);
    const next = await this.deps.store.updateRun(run.id, run.stateVersion, { ...patch, state: to });
    if (!next) throw new Error(`optimistic-concurrency conflict on ${run.id}`);
    await this.deps.store.appendEvent({
      runId: run.id,
      eventType: ev.type,
      source: ev.source,
      headSha: ev.headSha ?? next.headSha,
      idempotencyKey: ev.key,
      payload: ev.payload ?? {},
    });
    return next;
  }
  private async patch(run: Run, patch: RunPatch): Promise<Run> {
    const next = await this.deps.store.updateRun(run.id, run.stateVersion, patch);
    if (!next) throw new Error(`optimistic-concurrency conflict on ${run.id}`);
    return next;
  }

  private schedule(fn: () => void): void {
    queueMicrotask(fn);
  }
  private withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      runId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}
