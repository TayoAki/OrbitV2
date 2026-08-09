import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildSystem, startPump } from "../src/index";
import { createHttpServer } from "../src/http";
import type { Repository } from "../src/domain";

const repo: Repository = {
  id: "repo_demo", githubRepoId: 424242, installationId: 9999,
  owner: "TayoAki", name: "OrbitV2", defaultBranch: "main", enabled: true, requiredChecks: ["build", "test"],
};

async function poll(url: string, pred: (j: any) => boolean, timeoutMs = 3000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = await (await fetch(url)).json();
    if (pred(j)) return j;
    if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(j).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("HTTP: create → provision (pump) → approve → merged, end to end", async () => {
  const system = buildSystem([repo]);
  const stopPump = startPump(system, 20);
  const server = createHttpServer(system);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    const created = await fetch(`${base}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws", repositoryId: repo.id, creatorUserId: "u", title: "t", instructions: "do it" }),
    });
    assert.equal(created.status, 201);
    const run = (await created.json()) as any;
    assert.equal(run.state, "QUEUED");

    // The pump drives provisioning; the run reaches AWAITING_HUMAN on its own.
    await poll(`${base}/v1/runs/${run.id}`, (j) => j.run?.state === "AWAITING_HUMAN");

    const inbox = (await (await fetch(`${base}/v1/inbox`)).json()) as any;
    assert.ok(inbox.runs.some((r: any) => r.id === run.id));

    const approve = await fetch(`${base}/v1/runs/${run.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approverUserId: "u", approverGithubUserId: 42 }),
    });
    assert.equal(approve.status, 200);
    await poll(`${base}/v1/runs/${run.id}`, (j) => j.run?.state === "DONE");
  } finally {
    stopPump();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("HTTP: webhook with a bad signature is rejected 401", async () => {
  const system = buildSystem([repo]);
  const server = createHttpServer(system);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/v1/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-delivery": "d1", "x-github-event": "push", "x-hub-signature-256": "sha256=bad" },
      body: JSON.stringify({ action: "opened" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
