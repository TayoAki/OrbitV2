import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSystem, waitForState, greenPush, type World } from "./_harness";
import { CAPS, branchFor, type CheckObservation } from "../src/domain";

test("CI keeps failing → bounded repairs → BLOCKED (AUTOMATION_EXHAUSTED)", async () => {
  // World where every pushed commit fails the 'test' check.
  const failWorld = async (w: World) => {
    const run = await w.store.getRun(w.runId);
    if (!run) return;
    const branch = run.branchName ?? branchFor(w.runId);
    w.github.pushBranch(w.repo, branch, w.sha);
    const checks: CheckObservation[] = [
      { name: "build", headSha: w.sha, status: "completed", conclusion: "success", required: true },
      { name: "test", headSha: w.sha, status: "completed", conclusion: "failure", required: true },
    ];
    w.github.setChecks(w.repo, w.sha, checks);
    await w.orchestrator.onBranchPushed(w.runId, w.sha);
  };
  const sys = makeSystem({ onPush: failWorld });
  const run = await sys.runService.createRun({
    workspaceId: "ws", repositoryId: sys.repo.id, creatorUserId: "u",
    title: "x", instructions: "y", acceptanceCriteria: { criteria: [], browserRequired: false },
  });
  await sys.orchestrator.provision(run.id);
  const blocked = await waitForState(sys.store, run.id, ["BLOCKED"]);
  assert.equal(blocked.attentionReason, "AUTOMATION_EXHAUSTED");
  assert.equal(blocked.ciRepairAttempts, CAPS.CI_REPAIR_MAX);

  // Escalated runs surface in the inbox.
  const inbox = await sys.runService.inbox("ws");
  assert.ok(inbox.some((r) => r.id === run.id));
});

test("review requests changes then approves → merges after one revision", async () => {
  let pushes = 0;
  const world = async (w: World) => {
    pushes += 1;
    const first = pushes === 1;
    const run = await w.store.getRun(w.runId);
    if (!run) return;
    const branch = run.branchName ?? branchFor(w.runId);
    w.github.pushBranch(w.repo, branch, w.sha);
    w.github.setChecks(w.repo, w.sha, w.repo.requiredChecks.map((name) => ({
      name, headSha: w.sha, status: "completed" as const, conclusion: "success" as const, required: true,
    })));
    await w.orchestrator.onBranchPushed(w.runId, w.sha);
    const fresh = await w.store.getRun(w.runId);
    if (fresh?.prNumber == null) return;
    // First head: reviewer requests changes. Second head: approves.
    w.github.setReview(w.repo, fresh.prNumber, {
      provider: w.review.name, headSha: w.sha,
      state: first ? "CHANGES_REQUESTED" : "APPROVED",
      round: pushes, blockingComments: first ? 2 : 0, submittedAt: new Date().toISOString(),
    });
    await w.orchestrator.evaluate(w.runId);
  };
  const sys = makeSystem({ onPush: world });
  const run = await sys.runService.createRun({
    workspaceId: "ws", repositoryId: sys.repo.id, creatorUserId: "u",
    title: "x", instructions: "y", acceptanceCriteria: { criteria: [], browserRequired: false },
  });
  await sys.orchestrator.provision(run.id);
  const ready = await waitForState(sys.store, run.id, ["AWAITING_HUMAN"]);
  assert.equal(ready.reviewRound, 1); // one revision consumed
  const events = await sys.store.listEvents(run.id);
  assert.ok(events.some((e) => e.eventType === "review.changes_requested" || e.eventType === "agent.review_fix.started"));
});

// silence unused import in some TS configs
void greenPush;
