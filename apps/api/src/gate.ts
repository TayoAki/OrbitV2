// ─────────────────────────────────────────────────────────────────────────────
// Gate computations. Every function is bound to a specific head SHA — a result
// for SHA A must never advance SHA B. The orchestrator composes these into the
// idempotent evaluateRun loop; the snapshot recorded when all gates pass is
// immutable and hashed, and the human approves *that hash*. (Blueprint §"gating".)
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from "node:crypto";
import type { Deps } from "./ports";
import type { Run, Repository, GateSnapshot } from "./domain";

export interface CiResult {
  complete: boolean;
  failed: boolean;
  passedChecks: string[];
  failedChecks: string[];
}

/** Never "all visible checks green" — only the repo's REQUIRED (base-snapshotted) checks. */
export async function computeRequiredCi(deps: Deps, repo: Repository, headSha: string): Promise<CiResult> {
  const required = repo.requiredChecks;
  if (required.length === 0) return { complete: true, failed: false, passedChecks: [], failedChecks: [] };
  const checks = await deps.github.listChecks(repo, headSha);
  const byName = new Map(checks.filter((c) => c.headSha === headSha).map((c) => [c.name, c] as const));
  const passed: string[] = [];
  const failed: string[] = [];
  let complete = true;
  for (const name of required) {
    const c = byName.get(name);
    if (!c || c.status !== "completed") {
      complete = false; // still running / not reported → wait
      continue;
    }
    if (c.conclusion === "success" || c.conclusion === "skipped") passed.push(name);
    else failed.push(name);
  }
  return { complete, failed: failed.length > 0, passedChecks: passed, failedChecks: failed };
}

export interface ReviewResult {
  approved: boolean;
  changesRequested: boolean;
  provider: string;
  round: number;
  blockingComments: number;
}

export async function computeReview(deps: Deps, repo: Repository, prNumber: number, headSha: string): Promise<ReviewResult> {
  const reviews = await deps.github.listReviews(repo, prNumber);
  const current = reviews
    .filter((r) => r.provider === deps.review.name && deps.review.isCurrent(r, headSha))
    .sort((a, b) => a.round - b.round);
  const latest = current.at(-1);
  if (!latest) return { approved: false, changesRequested: false, provider: deps.review.name, round: 0, blockingComments: 0 };
  return {
    approved: latest.state === "APPROVED",
    changesRequested: latest.state === "CHANGES_REQUESTED",
    provider: latest.provider,
    round: latest.round,
    blockingComments: latest.blockingComments,
  };
}

export interface BrowserResult {
  required: boolean;
  passed: boolean;
}

/** Browser verification is SHA-bound too — a PASS on the base or an old head can't
 *  verify the current head. Recorded via `browser.verification.completed` events. */
export async function computeBrowser(deps: Deps, run: Run, headSha: string): Promise<BrowserResult> {
  if (!run.acceptanceCriteria.browserRequired) return { required: false, passed: true };
  const events = await deps.store.listEvents(run.id);
  const passed = events.some(
    (e) => e.eventType === "browser.verification.completed" && e.headSha === headSha && e.payload["result"] === "PASS",
  );
  return { required: true, passed };
}

/** Canonical, hashed gate snapshot — the human approves this exact hash. */
export function buildGateSnapshot(input: {
  runId: string;
  headSha: string;
  ciChecks: string[];
  reviewProvider: string;
  reviewRound: number;
  browser: BrowserResult;
  mergeable: boolean;
}): GateSnapshot {
  const body = {
    run_id: input.runId,
    head_sha: input.headSha,
    ci: { status: "PASS" as const, checks: [...input.ciChecks].sort() },
    review: { status: "APPROVED" as const, provider: input.reviewProvider, round: input.reviewRound },
    browser: { status: input.browser.required ? ("PASS" as const) : ("NOT_REQUIRED" as const) },
    mergeable: input.mergeable,
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, runId: input.runId, headSha: input.headSha, hash, createdAt: new Date().toISOString() };
}
