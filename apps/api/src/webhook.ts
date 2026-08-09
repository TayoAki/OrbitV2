// ─────────────────────────────────────────────────────────────────────────────
// GitHub webhook intake. Three non-negotiables from the blueprint:
//   1. Verify X-Hub-Signature-256 (HMAC-SHA256 over the RAW body) in constant time
//      before trusting a single byte. An unsigned/mis-signed delivery is dropped.
//   2. Deduplicate on the X-GitHub-Delivery id (at-least-once delivery is expected).
//   3. NEVER run the state machine inside the webhook request — enqueue an evaluate
//      job and return 202. The pump drives the orchestrator asynchronously.
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Deps } from "./ports";
import type { RunService } from "./runService";

export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal length
  return timingSafeEqual(a, b);
}

export interface WebhookRequest {
  deliveryId: string | undefined;
  event: string | undefined;
  signature: string | undefined;
  rawBody: Buffer;
}
export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/** `resolveRepositoryId` maps a GitHub numeric repo id to our internal repo id. */
export async function handleGithubWebhook(
  deps: Deps,
  runService: RunService,
  resolveRepositoryId: (githubRepoId: number) => Promise<string | null>,
  req: WebhookRequest,
): Promise<WebhookResult> {
  if (!verifySignature(deps.config.webhookSecret, req.rawBody, req.signature)) {
    return { status: 401, body: { error: "invalid signature" } };
  }
  if (!req.deliveryId) return { status: 400, body: { error: "missing delivery id" } };

  let payload: GithubPayload;
  try {
    payload = JSON.parse(req.rawBody.toString("utf8")) as GithubPayload;
  } catch {
    return { status: 400, body: { error: "invalid json" } };
  }

  const isNew = await deps.store.recordDelivery(req.deliveryId, req.event ?? "", payload.action ?? null);
  if (!isNew) return { status: 200, body: { deduped: true } }; // already processed

  const affected = await affectedRuns(deps, runService, resolveRepositoryId, req.event ?? "", payload);
  for (const runId of affected) {
    // Enqueue — do not evaluate here. The pump calls orchestrator.evaluate(runId).
    await deps.store.publishOutbox({ jobType: "run.evaluate", runId, payload: { event: req.event } });
  }
  return { status: 202, body: { accepted: affected.length } };
}

interface GithubPayload {
  action?: string;
  repository?: { id?: number };
  pull_request?: { number?: number };
  check_run?: { pull_requests?: { number: number }[] };
  check_suite?: { pull_requests?: { number: number }[] };
  number?: number;
}

async function affectedRuns(
  deps: Deps,
  runService: RunService,
  resolveRepositoryId: (githubRepoId: number) => Promise<string | null>,
  event: string,
  payload: GithubPayload,
): Promise<string[]> {
  const githubRepoId = payload.repository?.id;
  if (githubRepoId == null) return [];
  const repositoryId = await resolveRepositoryId(githubRepoId);
  if (!repositoryId) return [];

  const prNumbers = new Set<number>();
  if (payload.pull_request?.number != null) prNumbers.add(payload.pull_request.number);
  if (payload.number != null && (event === "pull_request" || event === "pull_request_review")) prNumbers.add(payload.number);
  for (const p of payload.check_run?.pull_requests ?? []) prNumbers.add(p.number);
  for (const p of payload.check_suite?.pull_requests ?? []) prNumbers.add(p.number);

  const out: string[] = [];
  for (const n of prNumbers) {
    const run = await runService.findRunByPr(repositoryId, n);
    if (run) out.push(run.id);
  }
  // Avoid unused-var lint on deps in the skeleton (kept for parity with prod signature).
  void deps;
  return out;
}
