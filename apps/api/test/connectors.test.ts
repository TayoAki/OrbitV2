import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConnectorRegistry, type Connector, type ValidationResult } from "../src/connectors";
import { ConnectorService } from "../src/connectorService";
import { MemoryStore } from "../src/store.memory";
import { SimGitHub } from "../src/adapters/github.stub";
import { CodespacesExecutionProvider } from "../src/adapters/execution.codespaces";
import { CodeRabbitReviewProvider } from "../src/adapters/review.coderabbit";
import { PassthroughSecrets, StubArtifacts } from "../src/adapters/misc.stub";
import type { Deps } from "../src/ports";
import type { ConnectorName } from "../src/domain";

function makeDeps() {
  return {
    store: new MemoryStore(),
    github: new SimGitHub(),
    execution: new CodespacesExecutionProvider(),
    review: new CodeRabbitReviewProvider(),
    secrets: new PassthroughSecrets(),
    artifacts: new StubArtifacts(),
    config: { webhookSecret: "t", controlPlaneUrl: "u", promptVersion: "v" },
  } as Deps;
}

class FakeConnector implements Connector {
  needsGithubToken = false;
  constructor(
    readonly name: ConnectorName,
    readonly displayName: string,
    readonly category: string,
    private result: ValidationResult,
  ) {}
  async validate(): Promise<ValidationResult> {
    return this.result;
  }
}

test("connect persists an encrypted key only when validation succeeds", async () => {
  const deps = makeDeps();
  const registry = {
    linear: new FakeConnector("linear", "Linear", "issue-tracker", { ok: true, status: 200, account: "Acme", detail: "ok" }),
    coderabbit: new FakeConnector("coderabbit", "CodeRabbit", "code-review", { ok: false, status: 401, detail: "bad key" }),
    greptile: new FakeConnector("greptile", "Greptile", "code-context", { ok: true, status: 200, detail: "ok" }),
  } as Record<ConnectorName, Connector>;
  const svc = new ConnectorService(deps, registry);

  const good = await svc.connect("ws", "linear", { apiKey: "sekret" });
  assert.equal(good.ok, true);
  const stored = await deps.store.getConnector("ws", "linear");
  assert.equal(stored?.status, "connected");
  assert.equal(stored?.accountLabel, "Acme");
  assert.ok(stored?.encryptedKey && stored.encryptedKey !== "sekret", "key is stored encrypted, not plaintext");

  const bad = await svc.connect("ws", "coderabbit", { apiKey: "wrong" });
  assert.equal(bad.ok, false);
  assert.equal(await deps.store.getConnector("ws", "coderabbit"), null, "invalid key is not persisted");
});

test("list never leaks the key; disconnect removes it", async () => {
  const deps = makeDeps();
  const registry = {
    linear: new FakeConnector("linear", "Linear", "issue-tracker", { ok: true, status: 200, account: "Acme", detail: "ok" }),
    coderabbit: new FakeConnector("coderabbit", "CodeRabbit", "code-review", { ok: true, status: 200, detail: "ok" }),
    greptile: new FakeConnector("greptile", "Greptile", "code-context", { ok: true, status: 200, detail: "ok" }),
  } as Record<ConnectorName, Connector>;
  const svc = new ConnectorService(deps, registry);
  await svc.connect("ws", "linear", { apiKey: "sekret" });

  const list = await svc.list("ws");
  assert.equal(list.length, 3);
  const linear = list.find((c) => c.provider === "linear")!;
  assert.equal(linear.status, "connected");
  assert.equal(JSON.stringify(list).includes("sekret"), false, "no key material in the public list");
  const cr = list.find((c) => c.provider === "coderabbit")!;
  assert.equal(cr.status, "not_configured");

  await svc.disconnect("ws", "linear");
  assert.equal((await svc.list("ws")).find((c) => c.provider === "linear")!.status, "not_configured");
});

test("greptile requires a github token", async () => {
  const deps = makeDeps();
  const registry = buildConnectorRegistry();
  const svc = new ConnectorService(deps, registry);
  await assert.rejects(() => svc.connect("ws", "greptile", { apiKey: "x" }), /githubToken is required/);
});

// ── LIVE: proves each connector actually reaches its real provider ────────────
// Opt-in (network). A dummy key MUST be rejected by the real API (ok:false, 401-ish),
// which is the proof the connector is wired to the live service, not stubbed.
test("LIVE: real providers reject a dummy key", { skip: process.env.LIVE_CONNECTORS !== "1" }, async () => {
  const reg = buildConnectorRegistry();
  const lin = await reg.linear.validate({ apiKey: "lin_api_dummy" });
  assert.equal(lin.ok, false);
  assert.ok(lin.status >= 400, `linear reached (status ${lin.status})`);

  const cr = await reg.coderabbit.validate({ apiKey: "cr-dummy" });
  assert.equal(cr.ok, false);
  assert.equal(cr.status, 401);

  const grp = await reg.greptile.validate({ apiKey: "grp_dummy", githubToken: "gh_dummy" });
  assert.equal(grp.ok, false);
  assert.ok(grp.status >= 400, `greptile reached (status ${grp.status})`);
});
