// ─────────────────────────────────────────────────────────────────────────────
// HTTP surface — a dependency-free Node server. Thin transport over RunService +
// Orchestrator; all correctness lives below this line. Live updates are served as
// Server-Sent Events by tailing the append-only run event log (the same log the
// frontend folds into Run state), so the client contract matches apps/web.
// ─────────────────────────────────────────────────────────────────────────────
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Deps } from "./ports";
import { RunService, HttpError } from "./runService";
import type { Orchestrator } from "./orchestrator";
import type { ConnectorService } from "./connectorService";
import { handleGithubWebhook } from "./webhook";

export interface App {
  deps: Deps;
  runService: RunService;
  orchestrator: Orchestrator;
  connectors: ConnectorService;
  resolveRepositoryId: (githubRepoId: number) => Promise<string | null>;
}

// Browser calls come from the (different-origin) web app; keys travel in POST
// bodies, not cookies, so a permissive origin is safe here.
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export function createHttpServer(app: App): Server {
  return createServer((req, res) => {
    handle(app, req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, { error: (err as Error).message ?? "internal error" });
    });
  });
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (method === "GET" && path === "/healthz") return send(res, 200, { ok: true });

  // ── connectors (Linear / CodeRabbit / Greptile) ─────────────────────────────
  if (method === "GET" && path === "/v1/connectors") {
    const ws = url.searchParams.get("workspaceId");
    if (!ws) return send(res, 400, { error: "workspaceId required" });
    return send(res, 200, { connectors: await app.connectors.list(ws) });
  }
  if (method === "GET" && path === "/v1/connectors/linear/issues") {
    const ws = url.searchParams.get("workspaceId");
    if (!ws) return send(res, 400, { error: "workspaceId required" });
    return send(res, 200, { issues: await app.connectors.linearIssues(ws) });
  }
  const connTest = /^\/v1\/connectors\/([^/]+)\/test$/.exec(path);
  if (method === "POST" && connTest) {
    const body = (await readJson(req)) as { workspaceId?: string };
    if (!body.workspaceId) return send(res, 400, { error: "workspaceId required" });
    const result = await app.connectors.test(body.workspaceId, decodeURIComponent(connTest[1]));
    return send(res, result.ok ? 200 : 400, result);
  }
  const connOne = /^\/v1\/connectors\/([^/]+)$/.exec(path);
  if (method === "POST" && connOne) {
    const body = (await readJson(req)) as { workspaceId?: string; apiKey?: string; githubToken?: string };
    if (!body.workspaceId || !body.apiKey) return send(res, 400, { error: "workspaceId and apiKey required" });
    const result = await app.connectors.connect(body.workspaceId, decodeURIComponent(connOne[1]), { apiKey: body.apiKey, githubToken: body.githubToken });
    return send(res, result.ok ? 200 : 400, result);
  }
  if (method === "DELETE" && connOne) {
    const ws = url.searchParams.get("workspaceId");
    if (!ws) return send(res, 400, { error: "workspaceId required" });
    await app.connectors.disconnect(ws, decodeURIComponent(connOne[1]));
    return send(res, 200, { disconnected: true });
  }

  // POST /v1/webhooks/github — raw body needed for signature verification.
  if (method === "POST" && path === "/v1/webhooks/github") {
    const rawBody = await readRawBody(req);
    const result = await handleGithubWebhook(app.deps, app.runService, app.resolveRepositoryId, {
      deliveryId: header(req, "x-github-delivery"),
      event: header(req, "x-github-event"),
      signature: header(req, "x-hub-signature-256"),
      rawBody,
    });
    return send(res, result.status, result.body);
  }

  if (method === "POST" && path === "/v1/runs") {
    const body = await readJson(req);
    const run = await app.runService.createRun(body as never);
    return send(res, 201, run);
  }

  if (method === "GET" && path === "/v1/runs") {
    const runs = await app.runService.listRuns(url.searchParams.get("repositoryId") ?? undefined, url.searchParams.get("workspaceId") ?? undefined);
    return send(res, 200, { runs });
  }

  if (method === "GET" && path === "/v1/inbox") {
    const runs = await app.runService.inbox(url.searchParams.get("workspaceId") ?? undefined);
    return send(res, 200, { runs });
  }

  const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(path);
  if (method === "GET" && runMatch) {
    const found = await app.runService.getRun(decodeURIComponent(runMatch[1]));
    if (!found) return send(res, 404, { error: "run not found" });
    return send(res, 200, found);
  }

  const eventsMatch = /^\/v1\/runs\/([^/]+)\/events$/.exec(path);
  if (method === "GET" && eventsMatch) {
    return streamEvents(app, decodeURIComponent(eventsMatch[1]), req, res);
  }

  const approveMatch = /^\/v1\/runs\/([^/]+)\/approve$/.exec(path);
  if (method === "POST" && approveMatch) {
    const body = (await readJson(req)) as { approverUserId?: string; approverGithubUserId?: number };
    if (!body.approverUserId || typeof body.approverGithubUserId !== "number") {
      return send(res, 400, { error: "approverUserId and approverGithubUserId required" });
    }
    const result = await app.orchestrator.approve({
      runId: decodeURIComponent(approveMatch[1]),
      approverUserId: body.approverUserId,
      approverGithubUserId: body.approverGithubUserId,
    });
    return send(res, result.ok ? 200 : 409, result);
  }

  const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path);
  if (method === "POST" && cancelMatch) {
    const body = (await readJson(req)) as { userId?: string };
    const ok = await app.orchestrator.cancel(decodeURIComponent(cancelMatch[1]), body.userId ?? "unknown");
    return send(res, ok ? 200 : 409, { cancelled: ok });
  }

  send(res, 404, { error: "not found" });
}

// ── SSE: tail the run's event log ────────────────────────────────────────────
async function streamEvents(app: App, runId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const exists = await app.deps.store.getRun(runId);
  if (!exists) return send(res, 404, { error: "run not found" });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...CORS,
  });
  let cursor = 0;
  let closed = false;
  const tick = async (): Promise<void> => {
    if (closed) return;
    const events = await app.deps.store.listEvents(runId);
    for (const e of events) {
      if (e.sequence > cursor) {
        cursor = e.sequence;
        res.write(`id: ${e.sequence}\nevent: ${e.eventType}\ndata: ${JSON.stringify(e)}\n\n`);
      }
    }
    const run = await app.deps.store.getRun(runId);
    res.write(`event: run.state\ndata: ${JSON.stringify({ state: run?.state, attentionReason: run?.attentionReason })}\n\n`);
  };
  await tick();
  const interval = setInterval(() => void tick(), 1000);
  const keepAlive = setInterval(() => !closed && res.write(": keep-alive\n\n"), 15000);
  req.on("close", () => {
    closed = true;
    clearInterval(interval);
    clearInterval(keepAlive);
  });
}

// ── tiny helpers ─────────────────────────────────────────────────────────────
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(json);
}
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid json body");
  }
}
