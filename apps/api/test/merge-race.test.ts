import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSystem, waitForState } from "./_harness";
import { branchFor } from "../src/domain";

// The load-bearing invariant: an approval is bound to a SHA. If the PR head moves
// between approval and merge, the merge MUST be refused and the approval invalidated.

test("SimGitHub.merge refuses a stale expected head SHA", async () => {
  const sys = makeSystem();
  const pr = await sys.github.createPullRequest({ repo: sys.repo, head: "b", base: "main", title: "t", body: "" });
  sys.github.pushBranch(sys.repo, "b", "sha_A");
  // approve at A, then the tip moves to B
  sys.github.pushBranch(sys.repo, "b", "sha_B");
  const refused = await sys.github.merge({ repo: sys.repo, prNumber: pr.number, expectedHeadSha: "sha_A" });
  assert.deepEqual(refused, { merged: false, sha: null });
  const ok = await sys.github.merge({ repo: sys.repo, prNumber: pr.number, expectedHeadSha: "sha_B" });
  assert.deepEqual(ok, { merged: true, sha: "sha_B" });
});

test("approving after the head moved is refused and the gate is invalidated", async () => {
  const sys = makeSystem();
  const run = await sys.runService.createRun({
    workspaceId: "ws", repositoryId: sys.repo.id, creatorUserId: "u",
    title: "x", instructions: "y", acceptanceCriteria: { criteria: [], browserRequired: false },
  });
  await sys.orchestrator.provision(run.id);
  const ready = await waitForState(sys.store, run.id, ["AWAITING_HUMAN"]);
  const gatedSha = ready.headSha!;
  const snap = await sys.store.getGateSnapshot(run.id);
  assert.equal(snap?.headSha, gatedSha);

  // Someone pushes a new commit to the PR branch AFTER the gate snapshot — but the
  // control plane hasn't processed that push yet (no onBranchPushed). The head now
  // disagrees with the approved SHA.
  const branch = ready.branchName ?? branchFor(run.id);
  sys.github.pushBranch(sys.repo, branch, "intruder_sha");

  const result = await sys.orchestrator.approve({ runId: run.id, approverUserId: "u", approverGithubUserId: 1 });
  assert.deepEqual(result, { ok: false, reason: "HEAD_MOVED" });

  // Gate + approval were invalidated; run dropped back to re-gate the new SHA.
  const after = await sys.store.getRun(run.id);
  assert.notEqual(after?.state, "DONE");
  assert.notEqual(after?.state, "MERGING");
  const approval = await sys.store.getValidApproval(run.id);
  assert.equal(approval, null);

  // Crucially: no merge.succeeded event was ever written.
  const events = await sys.store.listEvents(run.id);
  assert.equal(events.some((e) => e.eventType === "merge.succeeded"), false);
});

test("a run cannot be merged without ever holding a valid gate snapshot", async () => {
  const sys = makeSystem();
  const run = await sys.runService.createRun({
    workspaceId: "ws", repositoryId: sys.repo.id, creatorUserId: "u",
    title: "x", instructions: "y", acceptanceCriteria: { criteria: [], browserRequired: false },
  });
  await sys.orchestrator.provision(run.id);
  await waitForState(sys.store, run.id, ["AWAITING_HUMAN"]);
  // Forcibly clear the gate snapshot, then try to approve → must be rejected.
  await sys.store.invalidateGateSnapshots(run.id);
  const result = await sys.orchestrator.approve({ runId: run.id, approverUserId: "u", approverGithubUserId: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "GATE_STALE");
});
