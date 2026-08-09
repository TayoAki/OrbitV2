import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryStore } from "../src/store.memory";
import { verifySignature } from "../src/webhook";
import { makeSystem, waitForState } from "./_harness";

test("appendEvent is idempotent on (source, idempotencyKey)", async () => {
  const store = new MemoryStore();
  const a = await store.appendEvent({ runId: "r1", eventType: "run.created", source: "human", idempotencyKey: "k1" });
  const b = await store.appendEvent({ runId: "r1", eventType: "run.created", source: "human", idempotencyKey: "k1" });
  assert.ok(a);
  assert.equal(b, null); // duplicate suppressed
  const events = await store.listEvents("r1");
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, 1);
});

test("recordDelivery dedupes webhook delivery ids", async () => {
  const store = new MemoryStore();
  assert.equal(await store.recordDelivery("delivery-1"), true);
  assert.equal(await store.recordDelivery("delivery-1"), false);
});

test("a duplicate branch push (same SHA) is a no-op", async () => {
  const sys = makeSystem();
  const run = await sys.runService.createRun({
    workspaceId: "ws", repositoryId: sys.repo.id, creatorUserId: "u",
    title: "x", instructions: "y", acceptanceCriteria: { criteria: [], browserRequired: false },
  });
  await sys.orchestrator.provision(run.id);
  const ready = await waitForState(sys.store, run.id, ["AWAITING_HUMAN"]);
  const before = (await sys.store.listEvents(run.id)).length;
  // Re-deliver the same head SHA the run is already on.
  await sys.orchestrator.onBranchPushed(run.id, ready.headSha!);
  const after = (await sys.store.listEvents(run.id)).length;
  assert.equal(after, before); // no new events, no state churn
});

test("webhook signature verification (HMAC-SHA256 over the raw body)", () => {
  const secret = "test-secret";
  const body = Buffer.from(JSON.stringify({ action: "opened", number: 7 }));
  const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifySignature(secret, body, good), true);
  assert.equal(verifySignature(secret, body, "sha256=deadbeef"), false);
  assert.equal(verifySignature(secret, body, undefined), false);
  assert.equal(verifySignature("wrong-secret", body, good), false);
});
