import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, isTerminal, CANCELLABLE_STATES, UI_STATE, TERMINAL_STATES } from "../src/domain";

test("legal forward transitions are allowed", () => {
  assert.ok(canTransition("QUEUED", "PROVISIONING"));
  assert.ok(canTransition("CI_WAIT", "REVIEWING"));
  assert.ok(canTransition("CI_WAIT", "FIXING_CI"));
  assert.ok(canTransition("REVIEWING", "VERIFYING"));
  assert.ok(canTransition("VERIFYING", "AWAITING_HUMAN"));
  assert.ok(canTransition("AWAITING_HUMAN", "MERGING"));
  assert.ok(canTransition("MERGING", "DONE"));
});

test("illegal transitions are rejected", () => {
  assert.equal(canTransition("QUEUED", "DONE"), false);
  assert.equal(canTransition("BUILDING", "MERGING"), false);
  assert.equal(canTransition("CI_WAIT", "DONE"), false);
  assert.equal(canTransition("REVIEWING", "MERGING"), false);
  assert.equal(canTransition("MERGING", "CI_WAIT"), false); // must re-open via AWAITING_HUMAN
});

test("terminal states are dead ends", () => {
  for (const s of TERMINAL_STATES) {
    assert.ok(isTerminal(s));
    assert.equal(canTransition(s, "CI_WAIT"), false);
  }
});

test("merge is not cancellable, but pre-merge states are", () => {
  assert.equal(CANCELLABLE_STATES.has("MERGING"), false);
  assert.equal(CANCELLABLE_STATES.has("DONE"), false);
  assert.ok(CANCELLABLE_STATES.has("AWAITING_HUMAN"));
  assert.ok(CANCELLABLE_STATES.has("BUILDING"));
});

test("every internal state collapses to a UI state", () => {
  for (const s of Object.keys(UI_STATE) as (keyof typeof UI_STATE)[]) {
    assert.ok(UI_STATE[s], `${s} maps to a UI state`);
  }
  assert.equal(UI_STATE.CI_WAIT, "REVIEWING");
  assert.equal(UI_STATE.FIXING_CI, "BUILDING");
  assert.equal(UI_STATE.BLOCKED, "ESCALATED");
});
