# Master-Loop SaaS — MVP Build Plan

*"Assign a ticket, go to bed, wake up to a review-passed PR waiting for your approval."*

A SaaS that automates the practitioner's two-loop "master loop": a ticket becomes a PR that a coding agent builds and self-tests, a code-review tool loops on it until it passes, and only then does it reach a human. **We build no coding agent and no sandbox.** We are the **orchestration layer** that wires together best-of-breed tools the user already pays for — issue tracker, cloud coding agent, code-review bot, git host — via their APIs, with **any provider swappable per category** ("plug in your favorite code review tool").

This plan was synthesized from five subsystem designs and two adversarial reviews: an **API-reality check** (does each third-party API actually support this in 2026?) and an **MVP feasibility/sequencing** pass. Their reconciliations are baked in as canonical decisions below.

> **Relationship to `MASTER_PLAN.md`.** That document is a *different product* — building a Devin-style cloud agent from scratch in a Firecracker sandbox. This one orchestrates *existing* agents. The cloud agent from `MASTER_PLAN.md` is simply one future plug-in under this product's "coding agent" category. They share plumbing patterns (Workflow DevKit durable runs, an append-only event log, resumable SSE, KMS-encrypted secrets) but do **not** share a codebase yet, and none of that plumbing exists until built — treat every "reuse" as net-new MVP work.

---

## Table of contents
1. [The one reality that shapes everything: the API landscape](#1-the-api-landscape)
2. [The MVP decision: hardcode one toolchain first](#2-the-mvp-decision)
3. [Architecture & the single canonical loop](#3-architecture--the-single-canonical-loop)
4. [Frozen MVP contracts](#4-frozen-mvp-contracts)
5. [Subsystems, condensed](#5-subsystems-condensed)
6. [The roadmap — Phase 0→3](#6-the-roadmap)
7. [Top risks & the moat](#7-top-risks--the-moat)

---

## 1. The API landscape

The whole product is a bet on third-party APIs. The single riskiest assumption is the headline feature itself: **"loop until the review scores ≥ N" with any pluggable review tool.** Reality: **no review tool exposes a clean, normalized, machine-readable scored verdict** — they comment on the PR. So the loop's break-condition must degrade to what GitHub universally exposes.

**Confirmed vs. VERIFY vs. Fallback** (checked against 2026 provider docs — treat as the go/no-go table for Phase 0):

| Integration | Reality (2026) | Verdict | Must verify | Graceful-degrade fallback |
|---|---|---|---|---|
| **Cursor Cloud Agents** | Official Cloud Agents API + TS SDK; `POST api.cursor.com/v0/agents` launches on a repo, returns status, opens a PR. | **Confirmed** | Cursor 2.0 renamed Background→Cloud — pin request/response shape, PR-URL field, webhook availability (assume poll). | Generic PR-agent adapter (dispatch, then watch for the PR) — needs no vendor API. |
| **Devin (Cognition)** | Official API: `POST /v1/sessions`, `GET /v1/session/{id}`, `POST /v1/session/{id}/message` (true same-session follow-up), attachment upload; opens PRs. | **Confirmed, but ALPHA** | Explicitly alpha; a newer v3 org-scoped surface exists. Pin base/version; expect breaking changes; wrap behind the adapter. | Same generic PR-agent fallback. Ship Cursor first. |
| **Video / computer-use evidence via API** | Cursor 2.0 records videos; Devin attaches test recordings — but they surface in the webapp/Slack/as attachments, **not a reliable downloadable-URL API**. | **UI-first, not portable** | Whether *any* provider returns a fetchable video URL (per-provider capability flag). | **MVP gate = CI green + review passed; no video.** Reproduction-proof + video are fast-follows, never MVP merge-gate inputs. |
| **Greptile** | REST API is repo-index + NL query; the **0–5 merge-safety score is posted to the PR**, not cleanly returned by a review endpoint. | **Score exists; API-to-fetch-it VERIFY** | Is there a verdict endpoint, or only the PR comment? **Confirm score DIRECTION on a live PR** (5 = safe) — inverting it auto-merges bad code. | Parse `N/5` from the PR summary comment via the git-host adapter. |
| **CodeRabbit** | App-driven; posts structured comments to the PR; **no numeric score** (actionable vs nitpick). New CLI (`coderabbit review`) emits agent-friendly text in CI. | **App-driven, no JSON score** | Whether CLI output is stable to parse. | Verdict = the posted GitHub review (`approved`/`changes_requested`) via git-host; gate on severity, not a number. |
| **Qodo Merge / PR-Agent** | Hosted = app-driven GitHub App. **Self-hosted PR-Agent (OSS)** in GitHub Actions → most parseable output. | **Structured only if self-hosted** | "Review effort [1–5]" is *effort-to-review, not quality* — a polarity trap; map to `null`. | Self-host PR-Agent for structure, or read the PR review via git-host. |
| **Linear assign-to-agent** | `actor=app` OAuth creates an assignable/mentionable app user; `AgentSessionEvent` webhooks + `agentActivityCreate` streaming. Linear **also shipped first-party coding sessions** (assign → Claude Code/Codex). | **Confirmed** | Pin scopes + the ~10s "post an activity or the session is marked unresponsive" rule. **Strategic:** Linear is now itself a coding-agent competitor. | Plain webhook on issue label/assignee — one-tenth the surface, identical run engine. Use this for MVP. |
| **GitHub App merge** | `PUT /pulls/{n}/merge` updates the base ref. | **Scope claim suspect** | Merging via a GitHub App generally needs `contents:write`, not just `pull_requests:write`. Verify with a real merge or it 403s. | Keep `contents:write` until a live merge proves it droppable. |

**The load-bearing design consequence — GitHub is the universal verdict bus and aggregation hub:**
- Coding agents that open a PR → completion arrives as a GitHub `pull_request` event. No provider webhook to build.
- Review tools that run as GitHub Apps → "review done" arrives as `pull_request_review`. No provider webhook to build.
- The universal, always-available verdict = `pull_request_review.state` (`approved` | `changes_requested`) **+** Check Run `conclusion` (`success`/`failure`). A numeric score is an *optional per-adapter enhancement* — keep it nullable and gate on pass/fail so CodeRabbit (no score) and Greptile (0–5) ride the **same** loop. The pluggability thesis survives; it just gates on pass/fail, not a promised number.
- **Provider APIs are the source of truth; webhooks are a latency optimization.** A reconcile poll is the floor from day one, so a dropped webhook never hangs a run.

---

## 2. The MVP decision

**Pluggability is the product *vision*, not the week-1 job.** Building an adapter registry + capability matrix + per-category picker + DB-driven provider resolution *before* one toolchain works triples the surface for zero added value. Prove the loop end-to-end on **one hardcoded toolchain**, then extract interfaces from working code.

**The leanest MVP toolchain:**

| Category | Hardcode for MVP | Why this one first |
|---|---|---|
| Issue tracker | **Linear**, via a plain **label/assignee webhook** (`autoship` label) | Cleanest webhook + API; skips the uncertain agent-app (`actor=app`) surface. |
| Coding agent | **ONE agent that completes as a GitHub PR** — Cursor *or* Devin, decided by the Phase-0 spike | Completion-via-GitHub-PR makes the PR-opened webhook your completion + correlation signal for free. Resolves the "which agent" conflict by decree: pick one, hardcode it. |
| Git host | **GitHub App** (read PR/checks, post comments, merge) | Stable webhooks are the real backbone; the App gives short-lived scoped tokens (security). |
| Code review | **CodeRabbit, consumed via GitHub `pull_request_review`** (approved / changes_requested) | Zero separate review-API integration; reuses the GitHub webhook you already have; binary state sidesteps the numeric-polarity money-burn. Greptile's numeric mode is a Phase-3 alternative. |
| Verification | **Required CI checks green (`check_suite`)** — nothing more | The review verdict + CI green *is* "review-passed." No LLM judge, no evidence video, no reproduction-proof in week 1. |
| Human gate | **Dashboard approve** + a one-way email/Slack "ready" ping | Interactive Slack buttons, MCP, Linear elicitation all deferred. |

**MVP merge gate = `review == approved` AND all required checks green → pause for human → (human approves) → merge.** No home-grown judge that can itself hallucinate "passed." No numeric threshold UX for tools that emit no number.

**What is explicitly deferred out of MVP** (each proves no core value in week 1): the adapter registry + second providers of every category; the LLM/vision evidence judge; computer-use video as a gate; reproduction-proof CI machinery; the MCP server; the Linear Agent (`actor=app`) app; interactive Slack approve/reject; billing/Stripe metering; full multi-tenancy (5 roles, RLS everywhere). **The one thing that is NOT deferred: BYOK secret encryption + log redaction** — that cannot be retrofitted after a leak.

---

## 3. Architecture & the single canonical loop

```
                        ┌──────────── OUR ORCHESTRATION SaaS (Next.js on Vercel) ───────────┐
 Linear issue           │                                                                   │
 (label: autoship) ─────┼─► webhook gateway ─► startRun() ─► shipRun (durable WDK workflow)  │
                        │        ▲  ▲  ▲            │                │                       │
 GitHub App ────────────┼────────┘  │  │            │      ┌─────────┴──────────┐            │
 (pull_request,         │           │  │      dispatch/    │  guardrails:        │            │
  pull_request_review,  │           │  │      follow-up    │  iter caps,         │            │
  check_suite, push) ───┼───────────┘  │         │         │  oscillation guard, │            │
                        │              │         ▼         │  escalate-to-human  │            │
 Coding-agent API ──────┼──────────────┘   Cursor / Devin  └────────────────────┘            │
 (poll if no webhook)   │                        │ opens PR on the user's repo               │
                        │   run_events (append-only) ─► resumable SSE ─► Run dashboard        │
                        │   connections (BYOK, KMS-encrypted) · runs · external_refs          │
                        └────────────────────────────────────────────────────────────────────┘
```

**MVP loop topology = ONE loop** (the three subsystem drafts disagreed; this is the canonical resolution). Verification collapses into "CI green"; the second build-verify loop and the evidence judge are Phase 3.

```
QUEUED ─► BUILDING ─(agent PR + CI green)─► REVIEWING ─(approved)─► AWAITING_HUMAN
                                               │                        │ approve
                          (changes_requested & │◄───────────────┐       ▼
                           iters left & not     │  followUp +    │   READY_TO_MERGE ─► MERGING ─► DONE
                           stalled) REVIEW_FEEDBACK ─► push ─────┘       │ request_changes
                                               │                        └─► REVIEW_FEEDBACK
                                               ▼ exhausted / stalled / budget
                                           ESCALATED  (a pause, not a failure — human continues or aborts)
    off-ramps from any state: CANCELLED · FAILED
```

**Four durable pauses** where the run sleeps at $0 compute waiting on an external async job, each keyed by a **deterministic, iteration-scoped token** so a late/duplicate webhook for iteration N is inert once we've advanced to N+1:
1. **wait-agent** `agent:{runId}:{iter}` — resumed by the coding-agent webhook *or* GitHub `pull_request`; also gated on **wait-CI** (`check_suite.completed` for the exact `head_sha`) before reviewing.
2. **wait-review** `review:{runId}:{iter}` — resumed by `pull_request_review`.
3. **wait-push** `push:{runId}:{iter}` — resumed by GitHub `push`/`synchronize` after a review-feedback follow-up.
4. **wait-human** `human:{runId}` — resumed by the dashboard (or Slack/email deep link).

The durable workflow is ordinary control flow (`while`/`if`) inside a `"use workflow"` function; each pause is a single `await hook`. **Model timeout and cancel as `resumeHook` into the work token** (not `Promise.race` against `sleep`, whose replay determinism is unverified) so every pause stays a single deterministic await — verify this multi-wait/cancel shape in the Phase-0 spike, or switch the engine to Temporal.

---

## 4. Frozen MVP contracts

*The five sections defined `runs`/`run_events`/webhook-dedupe four different ways and the review verdict three different ways. Freeze these before any migration.*

**F1 — One review-verdict contract, pass/fail-first.** `normalizedScore` is **nullable**; the loop gates on a derived boolean. `score ≥ threshold` degrades cleanly to `state != changes_requested && checks green`. Surface `score_mode: numeric | pass_fail` **per connection**; never promise a number for a tool that emits none.
```ts
type ReviewVerdict = {
  provider: string;
  passed: boolean;                    // derived by policy, NOT a raw compare
  normalizedScore: number | null;     // 0–100 when a tool emits one (Greptile), else null
  decision: 'approve' | 'request_changes' | 'comment';
  blocking: ReviewComment[];          // at/above the policy severity
  summary: string; raw: unknown;      // keep the original for audit
};
```

**F2 — Verification verdict (MVP = deterministic only).** `{ status: 'passed' | 'failed' | 'escalate'; failing: string[]; evidence: EvidenceRef[] }`. MVP `passed` ⇔ required CI checks green. `escalate` (never a silent pass) on missing/ambiguous signal. The engine branches on exactly these three; the LLM judge that also emits this shape is Phase 3.

**F3 — One canonical schema** (the join spine that makes correlation work):
```sql
runs (
  id text PRIMARY KEY,               -- ULID
  org_id text NOT NULL,
  repo text NOT NULL,                -- owner/name
  source text NOT NULL,              -- linear_label | manual | mcp (later)
  ticket_ref text, ticket_url text,
  state run_state NOT NULL DEFAULT 'queued',
  review_iteration int NOT NULL DEFAULT 0,
  max_review_iterations int NOT NULL DEFAULT 3,   -- the real money ceiling (F5)
  review_threshold jsonb NOT NULL,   -- {decision:'approve'} default; {score:80} when numeric
  agent_provider text, agent_session_id text, review_provider text,
  pr_number int, pr_url text, head_sha text, base_branch text, head_branch text,
  policy_snapshot jsonb,             -- frozen resolved policy at start (audit + reproducibility)
  last_review_fp text, fp_repeat int NOT NULL DEFAULT 0, fp_ring jsonb,  -- oscillation guard
  budget_usd numeric, spent_usd numeric NOT NULL DEFAULT 0,  -- advisory (F5)
  workflow_run_id text, cancel_requested bool NOT NULL DEFAULT false,
  auto_merge bool NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), ended_at timestamptz
);
CREATE INDEX ON runs (repo, head_branch);                       -- GitHub webhook → run lookup
CREATE UNIQUE INDEX ON runs (repo, pr_number) WHERE pr_number IS NOT NULL;

run_events (                          -- append-only; the SSE feed + audit + UI reduction
  run_id text NOT NULL REFERENCES runs(id), seq int NOT NULL,   -- contiguous per-run from 1
  event_id text NOT NULL, type text NOT NULL,
  from_state run_state, to_state run_state, loop text, iteration int,
  payload jsonb, dedupe_key text NOT NULL, at timestamptz DEFAULT now(),
  PRIMARY KEY (run_id, seq), UNIQUE (run_id, dedupe_key)        -- idempotent step emits
);

external_refs (                       -- event → run correlation; one row per external id
  id text PRIMARY KEY, run_id text REFERENCES runs(id),
  kind text NOT NULL,                 -- agent_job | github_branch | github_pr | github_check_suite | review | linear_issue
  provider text NOT NULL, external_id text NOT NULL,
  UNIQUE (provider, kind, external_id)                          -- resolveRun() point-lookup
);

run_hooks (                           -- maps a WDK hook to the run + the event that resumes it
  id text PRIMARY KEY, run_id text REFERENCES runs(id),
  purpose text NOT NULL,              -- await_agent | await_ci | await_review | await_push | approval
  hook_token text NOT NULL, consumed_at timestamptz
);

webhook_deliveries (                  -- inbound at-least-once dedupe + replay buffer
  id text PRIMARY KEY, source text NOT NULL, delivery_id text NOT NULL,
  event_type text, received_at timestamptz DEFAULT now(), processed_at timestamptz,
  UNIQUE (source, delivery_id)
);
```

**F4 — Correlation, most-reliable-first** (the anti-race rule is load-bearing): write the expected ref **before** dispatching the agent, because the PR-opened webhook can beat our own bookkeeping. Keys: (1) **agent-job-id** stored at dispatch; (2) **controllable branch** `autoship/run-<runId>` *only when the provider accepts a branch* — third-party agents that pick their own branch fall through to (1)/(3); (3) **Linear-issue ↔ PR link** cross-check; (4) PR number / check-suite id → run. Any event resolving to no run goes to a `pending_events` buffer and is re-matched on the next ref insert or the reconcile sweep.

**F5 — Guardrails: hard iteration caps are the real ceiling, not dollars.** BYOK means the provider's cost signal is often absent, so `$ budgets are advisory` and **iteration caps are the enforced money ceiling**: `max_review_iterations` default **3**, (`max_build_iterations` **4** when the build-verify loop lands in Phase 3). Enforced in a `guard()` step at the top of every iteration, plus a `fingerprint()` after each verdict:
- **Fingerprint / no-progress:** `sha(sorted finding fingerprints + bucketed verdict)`; identical to the prior iteration → stalled after 2 repeats; score regression counts as stalled.
- **Oscillation guard:** keep the last 4 fingerprints; A→B→A (equals the one two steps back) → cycle → escalate.
- **Additive-scoped feedback:** every follow-up says "address ONLY these, don't touch the rest" — the top cause of oscillation is the agent churning the diff and re-triggering findings.
- **Escalate, don't die:** every guard trip → `ESCALATED` (a pause). Human `continue` (+ optional budget top-up) or `abort`. **Never silent-loop.**
- **Refuse vague tickets before dispatch:** the `needs_human_review` pre-dispatch gate (below) — a vague ticket is where autonomous loops incinerate money, so add a pre-dispatch state that refuses to start the loop until a human sharpens/approves the criteria.

**F6 — Idempotency & reliability:** every inbound webhook route does verify-HMAC(raw body) → dedupe on `(source, delivery_id)` (`ON CONFLICT DO NOTHING`) → only a first-seen delivery calls `resumeHook`. Iteration-scoped tokens (F4) make a duplicate that slips past inert. A **reconcile cron** (every 1–2 min) re-derives each active run's truth from GitHub/Linear/provider APIs and resumes any hook whose terminal event was dropped. Wrap side-effecting provider POSTs with a provider-side `Idempotency-Key` where supported. ACK-fast: verify → persist → enqueue → `200`; all real work async.

---

## 5. Subsystems, condensed

### 5.1 Provider layer (pluggability — but MVP hardcodes)
Four categories, each eventually a stable interface with swappable adapters; **MVP wires one concrete provider per category directly** and extracts the interface from that working code in Phase 3. The interfaces the engine will code against:
```ts
interface IssueTracker { getIssue(ref); addComment(ref, md); transition(ref, state); }
interface CodingAgent  { dispatch(req): {sessionId, providerRunId};  // returns a session we can follow up on
                         followUp(sessionId, instruction); parse(evt): AgentResult; cancel(sessionId);
                         supportsWebhook: boolean; }                  // false ⇒ engine polls
interface CodeReviewer { requestReview(pr): ReviewHandle; getVerdict(handle, policy): ReviewVerdict; }
interface GitHost      { getPR(ref); getChecks(sha); comment(ref, md); merge(ref, method); }
```
**Auth = BYOK, encrypted per-org** (the user already pays Cursor/Devin/CodeRabbit/Linear; we orchestrate, we don't resell). BYOK keeps us out of the billing path and each org's own rate-limit pool. **Exception:** the git host is *our* GitHub App, not a pasted PAT — short-lived scoped tokens, stable webhooks, correct bot attribution. We do **not** broker git-write credentials to the coding agent: the user connects Cursor/Devin to their repo inside those tools, so the agent brings its own push access — which means our GitHub App needs a *lighter* scope set than the sibling cloud-agent plan (mostly read + merge; keep `contents:write` until a live merge proves it droppable).

### 5.2 The engine
Owns dispatch, iteration control, feedback formatting, guardrails, the durable pauses, and the transition event log. **Feedback formatting is deterministic string templating** (zero tokens — directly serves the "don't burn my subscription" fear); an LLM summarizer is a Phase-3 alternative gated on `findings.length > N`. Cancellation is a cooperative `cancel:{runId}` hook awaited alongside every work token → best-effort `adapter.cancel()` to stop the provider burning tokens. **Engine runtime: Vercel Workflow DevKit** primary (durable control flow, `createHook` suspend/resume, step memoization as the cost/idempotency ledger); **Temporal** the alternative if the Phase-0 spike shows WDK's multi-wait/cancel/replay semantics don't hold.

### 5.3 Triggers, webhooks & correlation
**MVP trigger = a plain Linear webhook** on issue label (`autoship`) or assignee → `startRun()`; plus a manual dashboard "Start run" (zero external dependency, so it's the first thing that works). The Linear Agent app (`actor=app`, native assignable identity, activity stream, elicitation) and our own MCP server (`start_run`/`get_run_status`/`approve_run`) are **Phase 3** — the run engine is identical either way. One verified webhook gateway, per-source path (`/api/webhooks/{github,linear,agent/:provider}`), raw-body HMAC, delivery-id dedupe, fan-out via `resolveRun()` → `resumeHook`. Providers that don't webhook (Cursor/Devin — assume so until confirmed) get a backoff poller bounded by a max-duration reaper, with the reconcile cron as backstop.

### 5.4 Verification (MVP = CI green; the good ideas are fast-follows)
MVP gate is deterministic only: **required CI checks green + review passed + human approval**, fail-closed on missing/ambiguous evidence (a reviewer App that isn't actually installed → no verdict → **never** default-pass). Two ideas earn a fast-follow, not MVP:
- **Reproduction-proof** (a test that *fails on the base SHA and passes on the head SHA*) is the strongest cheap anti-spoof signal — it kills the "agent commits a green test that never exercises the bug" failure. But it needs its **own CI machinery** (a dedicated run that checks out the base commit and runs the added test — not a passive read of existing checks), so it's Phase 2/3 build work.
- **Acceptance-criteria extraction** from the Linear ticket (expected-behavior / steps-to-reproduce → a checkable list) feeds the `needs_human_review` pre-dispatch money-gate. MVP can start with a lightweight version (require the ticket to have expected-behavior text; refuse if absent); the full LLM structured-output extraction + vision judge of screenshots/video is Phase 3. **We never run computer-use ourselves** — if real video evidence is wanted later, the cleanest path is an optional Browserbase evidence adapter, explicitly opt-in (it means *we* run the browser, so it's a deliberate posture change, not MVP).

### 5.5 Product shell & BYOK security
Screens: **Connections** (per-category picker, BYOK key entry + GitHub App install, health dots + "test connection" — a preflight health gate rejects a run with `409` naming the broken provider, the single biggest "why didn't my run start" preventer), **Repos**, **Policy** (threshold, iteration caps, auto-merge off by default, require-human-approval on), **New run**, **Run list** ("needs your approval" saved view), **Run detail** (the main UI — state ribbon with iteration counters, timeline as a pure reduction of `run_events` over resumable SSE, score history, cost meter, prominent Approve/Reject). Auth: **Clerk** (orgs + roles + invites out of the box). **BYOK key custody is the top trust surface and is not deferrable:** per-org KMS-wrapped DEK, AES-256-GCM secrets, decrypt-in-adapter-only, write-only fields (GET returns `{last4, status}` never the value), aggressive log redaction of `sk-…`/`ghs_…`/`lin_api_…` patterns, per-org blast containment. Full RLS + 5-role RBAC + audit log can trim to a single-org-hardcoded shell for the invite-only MVP, but the encryption slice ships day one. Billing (Stripe metering) is **Phase 3**; MVP keeps only the iteration cap + an advisory budget as a guardrail. **Recommended pricing when it lands: a small per-seat floor + a metered charge per *successful merged PR* — failed loops cost the customer nothing from us**, which directly answers the burn anxiety.

---

## 6. The roadmap

*One ordered track, 1–3 devs, invite-only. Build order is driven by the external-API risk and the durable core: de-risk the volatile APIs, build the durable spine (which runs with zero external deps), wire ONE toolchain, add guardrails before unattended running, then generalize.*

### Phase 0 — De-risk & decide (spikes + contract freeze)
Throwaway scripts against **real accounts** that resolve every load-bearing unknown before product code:
- Register a Linear webhook; receive a label/assignment event.
- Mint a GitHub App installation token; read a PR + `check_suite`, post a comment, and **merge a throwaway PR** (confirms the real scope needed).
- Dispatch **both** candidate coding agents (Cursor, Devin); confirm each returns a PR and accepts a same-branch/same-session follow-up. **Pick the winner.**
- Read CodeRabbit's verdict off a real PR via `pull_request_review` (`approved`/`changes_requested`). If evaluating Greptile: **verify score direction on a live review.**
- Prove the WDK cancel + timeout + work-hook multi-wait pattern **under replay**. If it doesn't hold, choose Temporal now.
- **Freeze** F1–F6: one verdict shape, one `runs`/`run_events`/dedupe schema, one branch/correlation convention, one approval-hook scheme.

**Demo:** a terminal script drives Linear-event → agent-dispatch → PR → read-review → merge against live accounts + a one-page memo naming the hardcoded toolchain and engine runtime.

### Phase 1 — Thinnest end-to-end on the ONE hardcoded toolchain
No pluggability, no registry, no multi-tenant, no billing, no judge, no MCP, no Slack buttons. Just the loop, on real repos:

Linear `autoship` label → dispatch hardcoded agent (agent-job-id ref written **before** dispatch) → PR opened (correlated by the PR webhook) → CI green (`check_suite` for the exact head_sha) → CodeRabbit review via `pull_request_review` → if `changes_requested`: additive-scoped feedback → follow-up to the same session/branch → wait for push → re-review → on `approved` + checks green: pause for human → dashboard approve → merge → Linear → Done.

- Durable WDK (or Temporal) `shipRun` with the four pauses + timeout-as-resume.
- Webhook ingestion (raw-body HMAC, delivery-GUID dedupe) + correlation (`external_refs` point-lookup) + `pending_events` buffer + reconcile cron.
- **Iteration caps + oscillation/stall detection + escalate-to-human** from day one (the money ceiling).
- Secrets encrypted + key-pattern log redaction (single org hardcoded is fine).

**Demo (the core value proof):** assign a real ticket, walk away, come back to a review-passed PR awaiting approval; click approve → merged → ticket → Done. If a review fails, watch the auto-follow-up + re-review, then escalate after N iterations.

### Phase 2 — Make it safe, observable, onboard 2–3 design partners
Run dashboard (list + detail, resumable SSE over `run_events`, state ribbon, iteration counters, cost meter); guardrail hardening (fingerprint stall/oscillation, per-PR/per-org concurrency lock); one-way Slack/email "needs your approval" + "finished/failed" with deep link; the multi-tenancy slice (orgs/users/roles + RLS + per-org KMS DEK); dedupe + reconcile hardening (out-of-order and PR-before-ref race tests). **Reproduction-proof CI runner** lands here as the first real anti-spoof upgrade.

**Demo:** 2–3 external teams connect their own Linear + GitHub + agent + reviewer keys, run real tickets, watch live, approve from a deep link. Duplicate/late webhooks and a dropped terminal webhook (recovered by reconcile) are shown not to break a run.

### Phase 3 — Pluggability, deepen the gate, monetize
Extract interfaces from the working Phase-1/2 code → adapter registry + provider catalog + per-category picker + per-repo bindings; add second providers (Devin, Greptile numeric mode, GitHub Issues). Optional verification layer (deterministic pre-check + reproduction-proof already built + an LLM/vision judge behind a flag for high-risk repos + the full `needs_human_review` criteria gate). Billing (Stripe meter on merged PR). Surfaces: MCP server, Linear Agent app (`actor=app`) for native assignment + elicitation, interactive Slack approve/reject.

**Demo:** a user swaps CodeRabbit→Greptile and Cursor→Devin from the UI in minutes and reruns the same ticket; a vague ticket is refused with `needs_human_review`; billing charges only on the merged PR.

---

## 7. Top risks & the moat

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Over-reliance on a partner API that changes.** Every agent/review/Linear API is volatile; one endpoint change breaks dispatch or verdict-reading. | Make **completion-via-GitHub-PR + `pull_request_review`** the backbone (GitHub webhooks are stable). Gate the build on the Phase-0 spike. Thin adapter boundaries so a vendor swap is localized. Reconcile-poll floor so a broken webhook never hangs a run. |
| 2 | **Loops burning the user's money** (BYOK spend) via oscillation (fix A → break B). | **Hard iteration caps are the real ceiling** (review 3, build 4), not $ budgets. Fingerprint/oscillation/stall detection, additive-scoped feedback, **escalate-to-human on exhaustion (never silent loop)**, refuse vague tickets before dispatch. |
| 3 | **A fake/too-lenient quality gate** (green test that never hits the bug; treating anything short of `changes_requested` as pass; an LLM judge hallucinating success) → broken merged PRs, trust gone forever. | MVP gate = review `approved` + CI green + **reviewer App actually installed** (else no verdict → never default-pass). **Fail-closed** on missing/ambiguous evidence. **Human approval before merge** (auto_merge off). Reproduction-proof (base=fail→head=pass) as the deterministic anti-spoof fast-follow. Don't ship a home-grown judge that can itself hallucinate. |
| 4 | **Thin-wrapper defensibility** — anyone can wire the same APIs; Linear/Cursor/GitHub could ship the loop natively (Linear already ships first-party coding sessions). | The moat is **not the adapters** — it's the **reliable durable loop + correlation + oscillation control + cross-provider verdict normalization + audit trail**, plus the **tool-agnostic wedge** ("works across the tools you already pay for") that no single vendor's native loop serves. Win multi-tool teams first; spend engineering on loop reliability, not adapter breadth. |
| 5 | **BYOK key custody** — we hold the customer's whole-account credentials; a leak is fatal and enterprises won't paste keys into an unknown startup. | From day 1: **KMS envelope encryption (per-org DEK)**, decrypt-in-adapter-only, never return/log/URL secrets, **GitHub App (short-lived scoped tokens) not a PAT**, per-org blast containment. SOC 2 + pen-test on the enterprise roadmap. The one multi-tenancy slice you cannot defer. |

*(6th, honorable mention: betting the durable core on unverified WDK multi-wait/cancel primitives — resolve in Phase 0 or pick Temporal.)*

---

### One-paragraph summary
Build an orchestration SaaS that turns a Linear ticket into a merged PR by driving *other people's* tools through their APIs: dispatch one hardcoded coding agent (Cursor or Devin), let it open a PR, gate on **GitHub's universal verdict bus** — a code-review App's `pull_request_review` state plus CI checks green — loop the agent on review feedback until it passes with hard iteration caps as the money ceiling, then pause for a human to approve the merge. Prove that on **one hardcoded toolchain first**; make the four provider categories pluggable only after the loop is real. Freeze the run/event/correlation schema and the pass/fail verdict contract on day one, encrypt every BYOK key from the first commit, keep verification deterministic (CI green now, reproduction-proof and an LLM judge later), and remember the moat is the reliable durable loop and the tool-agnostic wedge — not the adapters anyone could write.
