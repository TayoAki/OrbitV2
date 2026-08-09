import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSystem, waitForState } from "./_harness";

test("R8: approval is refused if the human no longer holds write access", async () => {
  const sys = makeSystem();
  const run = await sys.runService.createRun({
    workspaceId: "ws", repositoryId: sys.repo.id, creatorUserId: "u",
    title: "x", instructions: "y", acceptanceCriteria: { criteria: [], browserRequired: false },
  });
  await sys.orchestrator.provision(run.id);
  await waitForState(sys.store, run.id, ["AWAITING_HUMAN"]);

  // Revoke the approver's write access on the repo, right now.
  sys.github.setUserWrite(1234, sys.repo, false);
  const result = await sys.orchestrator.approve({ runId: run.id, approverUserId: "u", approverGithubUserId: 1234 });
  assert.deepEqual(result, { ok: false, reason: "NO_WRITE_ACCESS" });

  const after = await sys.store.getRun(run.id);
  assert.equal(after?.state, "AWAITING_HUMAN"); // unchanged; still waiting
});

test("autonomous mode gates then auto-merges without a human", async () => {
  const sys = makeSystem();
  const run = await sys.runService.createRun({
    workspaceId: "ws", repositoryId: sys.repo.id, creatorUserId: "u",
    title: "x", instructions: "y", executionMode: "AUTONOMOUS",
    acceptanceCriteria: { criteria: [], browserRequired: false },
  });
  await sys.orchestrator.provision(run.id);
  const done = await waitForState(sys.store, run.id, ["DONE"]);
  const events = await sys.store.listEvents(done.id);
  assert.ok(events.some((e) => e.eventType === "merge.succeeded"));
  assert.ok(events.some((e) => e.eventType === "gate.machine_passed"));
  // No human.approved event — autonomy is the durable policy, not a person.
  assert.equal(events.some((e) => e.eventType === "human.approved"), false);
});

test("approve on a non-awaiting run is rejected", async () => {
  const sys = makeSystem();
  const run = await sys.runService.createRun({
    workspaceId: "ws", repositoryId: sys.repo.id, creatorUserId: "u",
    title: "x", instructions: "y", acceptanceCriteria: { criteria: [], browserRequired: false },
  });
  // Still QUEUED — approving is nonsense.
  const result = await sys.orchestrator.approve({ runId: run.id, approverUserId: "u", approverGithubUserId: 1 });
  assert.deepEqual(result, { ok: false, reason: "NOT_AWAITING" });
});
