import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRequiredCi, buildGateSnapshot, type BrowserResult } from "../src/gate";
import { SimGitHub } from "../src/adapters/github.stub";
import { MemoryStore } from "../src/store.memory";
import { PassthroughSecrets, StubArtifacts } from "../src/adapters/misc.stub";
import { CodespacesExecutionProvider } from "../src/adapters/execution.codespaces";
import { CodeRabbitReviewProvider } from "../src/adapters/review.coderabbit";
import type { Deps } from "../src/ports";
import type { Repository } from "../src/domain";

const repo: Repository = {
  id: "r", githubRepoId: 1, installationId: 1, owner: "o", name: "n",
  defaultBranch: "main", enabled: true, requiredChecks: ["build", "test"],
};

function deps(github: SimGitHub): Deps {
  return {
    store: new MemoryStore([repo]), github,
    execution: new CodespacesExecutionProvider(), review: new CodeRabbitReviewProvider(),
    secrets: new PassthroughSecrets(), artifacts: new StubArtifacts(),
    config: { webhookSecret: "s", controlPlaneUrl: "u", promptVersion: "v" },
  };
}

test("CI is not complete until every REQUIRED check reports at the head SHA", async () => {
  const gh = new SimGitHub();
  const d = deps(gh);
  gh.setChecks(repo, "aaa", [{ name: "build", headSha: "aaa", status: "completed", conclusion: "success", required: true }]);
  // 'test' hasn't reported → not complete, so we wait (not fail).
  const r1 = await computeRequiredCi(d, repo, "aaa");
  assert.equal(r1.complete, false);
  assert.equal(r1.failed, false);

  gh.setChecks(repo, "aaa", [
    { name: "build", headSha: "aaa", status: "completed", conclusion: "success", required: true },
    { name: "test", headSha: "aaa", status: "completed", conclusion: "success", required: true },
  ]);
  const r2 = await computeRequiredCi(d, repo, "aaa");
  assert.deepEqual([r2.complete, r2.failed], [true, false]);
  assert.deepEqual(r2.passedChecks.sort(), ["build", "test"]);
});

test("a failing required check fails CI", async () => {
  const gh = new SimGitHub();
  const d = deps(gh);
  gh.setChecks(repo, "bbb", [
    { name: "build", headSha: "bbb", status: "completed", conclusion: "success", required: true },
    { name: "test", headSha: "bbb", status: "completed", conclusion: "failure", required: true },
  ]);
  const r = await computeRequiredCi(d, repo, "bbb");
  assert.equal(r.failed, true);
  assert.deepEqual(r.failedChecks, ["test"]);
});

test("checks reported at a DIFFERENT SHA never satisfy the current head (SHA-bound)", async () => {
  const gh = new SimGitHub();
  const d = deps(gh);
  // green at the OLD sha only
  gh.setChecks(repo, "old", [
    { name: "build", headSha: "old", status: "completed", conclusion: "success", required: true },
    { name: "test", headSha: "old", status: "completed", conclusion: "success", required: true },
  ]);
  const r = await computeRequiredCi(d, repo, "new");
  assert.equal(r.complete, false); // nothing reported for 'new' → we must wait, not pass
});

test("gate snapshot hash is deterministic and order-independent", () => {
  const br: BrowserResult = { required: false, passed: true };
  const a = buildGateSnapshot({ runId: "run1", headSha: "sha1", ciChecks: ["test", "build"], reviewProvider: "coderabbit", reviewRound: 1, browser: br, mergeable: true });
  const b = buildGateSnapshot({ runId: "run1", headSha: "sha1", ciChecks: ["build", "test"], reviewProvider: "coderabbit", reviewRound: 1, browser: br, mergeable: true });
  assert.equal(a.hash, b.hash); // checks sorted before hashing
  const c = buildGateSnapshot({ runId: "run1", headSha: "sha2", ciChecks: ["build", "test"], reviewProvider: "coderabbit", reviewRound: 1, browser: br, mergeable: true });
  assert.notEqual(a.hash, c.hash); // different head → different gate
});
