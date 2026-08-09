# apps/api — Shipbot control plane

The backend for Orbit/Shipbot: an **event-driven state machine around Runs**. A
**Run** is the canonical object; the board, inbox, GitHub thread, PR, CI, review,
and executor are all projections/resources attached to it. This package is the
**Control plane** — the authority in the three-plane model
(Coordination = Nostr · **Control = these servers** · Execution = sandbox + agent
runtime). See [`../../PLATFORM_PLAN.md`](../../PLATFORM_PLAN.md).

It runs today with **zero runtime dependencies** (Node built-ins + `tsx`). Every
external service — GitHub, Codespaces, CodeRabbit, KMS — sits behind a port with an
in-memory stub, exactly like the frontend's sim engine, so the whole ship loop
compiles, runs, and is fully tested without any live credentials.

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # node --test (25 tests: state machine, gate, merge race, …)
npm run dev            # start the control plane on :8787 (in-memory, self-driving)
```

`npm run dev` boots a self-contained demo: create a run and it provisions, "builds",
opens a PR, greens CI, gets a review approval, and lands in the inbox awaiting a
human — then `POST /approve` merges it.

```bash
curl -s localhost:8787/v1/runs -XPOST -H 'content-type: application/json' \
  -d '{"workspaceId":"ws","repositoryId":"repo_demo","creatorUserId":"me","title":"Fix flaky test","instructions":"make it deterministic"}'
# → run.id ... watch it flow:
curl -s "localhost:8787/v1/runs/<id>"            # run + full event log
curl -sN "localhost:8787/v1/runs/<id>/events"     # live SSE stream
curl -s "localhost:8787/v1/inbox"                 # runs awaiting a human
curl -s localhost:8787/v1/runs/<id>/approve -XPOST -H 'content-type: application/json' \
  -d '{"approverUserId":"me","approverGithubUserId":42}'   # → merged
```

## The ship loop (internal state machine)

```
QUEUED → PROVISIONING → BUILDING → PR_OPEN → CI_WAIT ⇄ FIXING_CI
                                                  ↓
                                             REVIEWING ⇄ FIXING_REVIEW
                                                  ↓
                                             VERIFYING ⇄ FIXING_BROWSER
                                                  ↓
                                          AWAITING_HUMAN → MERGING → DONE
   off-ramps at every stage: BLOCKED (escalated) · FAILED · CANCELLED
```

The 16 internal states collapse to the 9 coarse states the frontend renders
(`UI_STATE` in [`src/domain.ts`](src/domain.ts)), so this backend and `apps/web`
speak the same contract.

## What is actually load-bearing (built for real, not stubbed)

- **SHA-bound gating.** Every external transition (CI, review, browser, approval,
  merge) is bound to a Git head SHA. A result for SHA A never advances SHA B. The
  gate snapshot is hashed and immutable; the human approves *that hash*.
  ([`src/gate.ts`](src/gate.ts), [`src/orchestrator.ts`](src/orchestrator.ts))
- **The merge race guard.** Between approval and merge the tip can move. Merge is
  conditioned on `expectedHeadSha`; if the tip moved, the merge is refused and the
  approval invalidated — never a stale merge. (`test/merge-race.test.ts`)
- **Control/execution credential separation.** PR creation and merge are
  control-plane-only, done with the control identity. The executor only ever gets a
  just-in-time, **single-repository short-lived contents-write** credential and only
  ever commits+pushes to `shipbot/run/<run-id>`. The App private key, user tokens,
  and merge-capable tokens never enter the executor.
- **Codespaces caveat, encoded.** A Codespace injects GitHub's *own* repo token, so
  the "agent only holds our push credential" boundary is **not** literally true for
  it — documented in [`src/adapters/execution.codespaces.ts`](src/adapters/execution.codespaces.ts).
  A future hardened-VM provider can make that claim real, and swaps in behind the
  same `ExecutionProvider` port.
- **Approve is a server transaction.** Re-check the user's GitHub write access (R8),
  verify current head == gate SHA, re-evaluate the gate, record a durable approval,
  submit the approval as the user, then merge. ([`src/orchestrator.ts`](src/orchestrator.ts))
- **Idempotent everywhere.** Append-only event log unique on `(source, idempotencyKey)`;
  webhooks verify `X-Hub-Signature-256` (HMAC-SHA256 over the raw body) and dedup on
  delivery id; the state machine never runs synchronously inside a webhook request —
  it enqueues an evaluate job. ([`src/webhook.ts`](src/webhook.ts))
- **Bounded repairs.** CI / review / browser repair budgets are hard ceilings
  (`CAPS` in `domain.ts`); exhaustion escalates to the inbox, never loops.
- **Optimistic concurrency + transactional outbox + per-run serialization** so two
  concurrent events can't interleave a transition.

## Layout

| File | Role |
| --- | --- |
| `src/domain.ts` | **The contract.** States, transitions, events, value objects, caps. |
| `src/ports.ts` | Seams: `Store`, `GitHubClient`, `ExecutionProvider`, `ReviewProvider`, … |
| `src/gate.ts` | SHA-bound gate computations + the immutable, hashed gate snapshot. |
| `src/orchestrator.ts` | The authority — owns every Run transition. |
| `src/runService.ts` | The one createRun entry point + read projections (board, inbox). |
| `src/webhook.ts` | Signed webhook intake → dedup → enqueue (never runs the SM inline). |
| `src/http.ts` | Dependency-free HTTP + SSE transport. |
| `src/index.ts` | Composition root + outbox pump + the self-driving demo world. |
| `src/store.memory.ts` | In-memory `Store` (swap for Postgres — see `db/schema.sql`). |
| `src/adapters/*` | Stub GitHub / Codespaces / CodeRabbit / secrets / artifacts. |
| `db/schema.sql` | The durable Postgres schema; invariants encoded as constraints. |

## Going to production

Replace four constructors in [`src/index.ts`](src/index.ts) — nothing above that
line changes:

1. `MemoryStore` → a Postgres `Store` (`db/schema.sql`).
2. `SimGitHub` → a real GitHub App client (JWT → scoped installation tokens).
3. `CodespacesExecutionProvider` → real Codespaces (OAuth/PAT create, SSH bootstrap)
   or a hardened-VM provider; wire the runner to the Copilot SDK.
4. `CodeRabbitReviewProvider.trigger` → the real provider (the review of record still
   lives on the GitHub PR).
