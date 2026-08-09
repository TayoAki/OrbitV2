import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSystem, waitForState } from "./_harness";

test("connect → task → build → PR → CI → review → AWAITING_HUMAN → approve → merged", async () => {
  const sys = makeSystem();
  const run = await sys.runService.createRun({
    workspaceId: "ws1",
    repositoryId: sys.repo.id,
    creatorUserId: "user_alice",
    title: "Fix the flaky checkout test",
    instructions: "Make the checkout integration test deterministic.",
    acceptanceCriteria: { criteria: ["checkout test passes 100 times"], browserRequired: false },
  });
  assert.equal(run.state, "QUEUED");

  await sys.orchestrator.provision(run.id);
  const ready = await waitForState(sys.store, run.id, ["AWAITING_HUMAN"]);
  assert.equal(ready.attentionReason, "READY_TO_MERGE");
  assert.ok(ready.prNumber, "a PR was opened by the control plane");
  assert.ok(ready.gateHash, "a gate snapshot was recorded");

  // The inbox is exactly the runs awaiting a human.
  const inbox = await sys.runService.inbox("ws1");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].id, run.id);

  // Approve as a user who currently holds write access.
  const result = await sys.orchestrator.approve({ runId: run.id, approverUserId: "user_alice", approverGithubUserId: 500 });
  assert.deepEqual(result, { ok: true });

  const done = await waitForState(sys.store, run.id, ["DONE"]);
  assert.equal(done.attentionReason, null);
  assert.equal(done.completedAt !== null, true);

  const events = await sys.store.listEvents(run.id);
  const names = events.map((e) => e.eventType);
  for (const expected of ["run.created", "pr.created", "ci.passed", "review.approved", "gate.machine_passed", "human.approved", "merge.succeeded", "run.done", "executor.destroyed"]) {
    assert.ok(names.includes(expected as never), `expected event ${expected} in [${names.join(", ")}]`);
  }
  // Event log has a strict per-run sequence with no gaps.
  const seqs = events.map((e) => e.sequence);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));

  // Executor was torn down.
  const ex = await sys.store.getExecutorForRun(run.id);
  assert.equal(ex?.status, "DESTROYED");
});

test("browser-required run waits for a VERIFY pass before gating", async () => {
  const sys = makeSystem();
  const run = await sys.runService.createRun({
    workspaceId: "ws1",
    repositoryId: sys.repo.id,
    creatorUserId: "u",
    title: "UI fix",
    instructions: "Fix the modal",
    acceptanceCriteria: { criteria: ["modal closes"], browserRequired: true },
  });
  await sys.orchestrator.provision(run.id);
  // The green world reports a VERIFY pass, so it still reaches AWAITING_HUMAN.
  const ready = await waitForState(sys.store, run.id, ["AWAITING_HUMAN"]);
  const snap = await sys.store.getGateSnapshot(run.id);
  assert.equal(snap?.browser.status, "PASS");
  assert.equal(ready.gateHash, snap?.hash);
});
