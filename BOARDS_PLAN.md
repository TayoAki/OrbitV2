# Boards — a native Trello/Kanban capability

*An addition to the platform plan. Grounded in a from-scratch "build Trello in 6 hours" build, and wired to the platform's AI coding agent + master loop.*

**The one-sentence thesis:** every other Kanban board's columns are dumb buckets a human drags cards between; **ours are a live projection of a durable state machine that an agent drives.** Assigning a card to an agent (or clicking **Solve**) starts a `shipRun`, and the run moves the card `To Do → In Progress → In Review → Needs Approval → Done`, commenting as it goes — because `card_id ↔ run_id` and the columns *are* the run's states. The board becomes the platform's **native issue tracker** (Linear and GitHub Issues demote to alternative adapters), reusing `shipRun`, the durable pauses, the R8 authorization gate, and the projection policy verbatim.

The Trello build gives us a concrete, battle-tested data model and a set of hard-won real-time lessons. This plan absorbs those and reconciles every seam with the existing four platform docs (`MASTER_PLAN.md`, `MVP_PLAN.md`, `PLATFORM_PLAN.md`). Where the module designs disagreed, the **Frozen decisions** table in §8 is canonical.

---

## Table of contents
1. [The keystone: columns *are* master-loop states](#1-the-keystone)
2. [The trigger: Solve → run, and correlation](#2-the-trigger)
3. [Progress: the card as a projection surface](#3-progress)
4. [Human approval as a card action](#4-human-approval)
5. [The data model (reconciled)](#5-the-data-model)
6. [Real-time: one event log, LWW, presence](#6-real-time)
7. [What the transcript taught us that we kept](#7-transcript-lessons)
8. [Frozen decisions](#8-frozen-decisions)
9. [Roadmap slot & phased build](#9-roadmap)
10. [Top risks](#10-top-risks)

---

## 1. The keystone

`shipRun` (from `MVP_PLAN.md`) is: `QUEUED → BUILDING → REVIEWING ⇄ REVIEW_FEEDBACK → AWAITING_HUMAN → READY_TO_MERGE → MERGING → DONE`, with off-ramps `ESCALATED · CANCELLED · FAILED`. **An agent board's columns are a 1:1 projection of that machine.** The card has no independent lifecycle — the run's state is the source of truth and the column is its view.

| Column (`kind`) | `shipRun` state(s) | Move authored by | Caused by |
|---|---|---|---|
| **To Do** | `QUEUED` / no run yet | human on create; agent on dispatch | card created / assigned-to-agent / **Solve** |
| **In Progress** | `BUILDING` | agent (projector) | `startRun()` → dispatch cloud agent (clone, read card, edit, test) |
| **In Review** | `REVIEWING` + `REVIEW_FEEDBACK` | agent | control plane opens PR → CI green → reviewer loop (CodeRabbit) |
| **Needs Approval** | `AWAITING_HUMAN` | agent | review approved + checks green → `wait-human` pause |
| *(transient)* | `READY_TO_MERGE → MERGING` | agent | human clicked **Approve** |
| **Done** | `DONE` (merged) | agent | GitHub App merge succeeds |
| **Blocked** | `ESCALATED` / `FAILED` | agent | guard trip (iteration cap / oscillation / stall), refusal, or hard failure |
| *(label `cancelled`)* | `CANCELLED` | human/agent | Cancel action |

**Blocked is a real column, not a silent loop.** The master loop's "escalate, don't die" rule surfaces here: an `ESCALATED` run parks the card in **Blocked** with a `needs-human` label and a comment naming *why* (caps exhausted / cycle detected / vague ticket). A human then **Continue**s (optional budget top-up → resume) or **Abort**s.

**The load-bearing invariant — single-writer-per-lane.** While `cards.active_run_id` is set, the run **owns** the `To Do…Done` lane: a human drag *across* those columns is rejected and snapped back (the run is the single writer, echoing the platform's single-writer `seq` invariant on `run_events`). Humans may still reorder *within* a column and use the explicit **Approve / Request-changes / Cancel / Continue** controls. The transcript's cuter "drag a card into In Progress to start it" is kept as pure sugar: **drag-to-column calls the same `/solve` endpoint, never an independent writer** — otherwise it races the projector and couples run dispatch to realtime liveness.

**Two board types.** *Agent boards* (`kind='agent'`) get these fixed, frozen run-state columns. *Plain boards* get dynamic admin-created sections, fully uncoupled from runs (the classic Trello surface). **The MVP ships only the agent board** — dynamic sections are deferred, because the agent bridge is the wedge and it's mostly reuse of `shipRun`.

---

## 2. The trigger

**One endpoint, two UIs.** Assigning a card to an agent identity **or** clicking **Solve** both hit:

```
POST /api/boards/cards/:cardId/solve
  → resolve repos: card_repos(card) ?? board.bound_repo
  → build task from card { title, body, acceptance criteria }
  → the platform's CHAIN OF AUTHORITY:  authorship → membership → binding → R8 GitHub re-check → run entry
  → needs_human_review pre-dispatch gate (refuse a vague card into Blocked BEFORE a loop burns budget)
  → WRITE correlation BEFORE dispatch (anti-race):  cards.active_run_id = runId; runs.card_id = cardId
  → startRun({ source:'board_card', ticket_ref: cardId, ticket_url: <card deep link>, repo, org_id })
```

This **replaces the Linear-label trigger** from the orchestration plan; `runs.source` simply gains `'board_card'` (it already enumerates `linear_label | manual | mcp`), and the card is the run's native ticket. The board is thus the first-party implementation of the `IssueTracker` interface every provider implements:

```
getIssue(cardId)          → { title, body, acceptanceCriteria }   // card fields
addComment(cardId, md)    → append a milestone comment              // the card's activity thread
transition(cardId, state) → move the card to that state's column    // the projection in §3
```

`shipRun` cannot tell whether a task came from Linear or a native card — the uniformity thesis holds.

**Assignment vs. auto-dispatch — the money-safety decision.** Assigning an agent only **stages** the card and reveals **Solve**; the explicit click is the spend authorization, which is what lets the `needs_human_review` gate refuse a vague card before a loop incinerates budget. Auto-dispatch-on-assign exists only as an **opt-in per-board policy** for trusted, well-specified backlogs. This is the sharpest new footgun, and it resolves the platform's "intent ≠ authorization" rule: a card click is not permission; the full chain re-runs before any sandbox boots.

**Correlation — a direct first-party FK, not an `external_refs` row.** Cards are Postgres rows, not an external system, so this matches the platform's own precedent (`sessions.workflow_run_id` is a direct column):

```sql
ALTER TABLE cards ADD COLUMN active_run_id text REFERENCES runs(id);
ALTER TABLE runs  ADD COLUMN card_id       text REFERENCES cards(id);
CREATE UNIQUE INDEX one_active_run_per_card ON cards (id) WHERE active_run_id IS NOT NULL;
```

The partial unique index enforces **one active run per card** — a second Solve on a running card is a no-op that surfaces the existing run, never a duplicate concurrent `shipRun`. Correlation is written **before** `startRun` because the `pull_request` webhook can beat our own bookkeeping. Completion still arrives on the existing GitHub bus: `pull_request` → `external_refs(github_pr) → run → run.card_id`, identical for Linear and board. **`external_refs` stays reserved for genuinely external ids** (Linear issue, GitHub PR); the card link is not one.

---

## 3. Progress

The run streams progress to the card by the **same projection policy** the platform uses for the Nostr thread (`run_events → {publish | summarize | drop}`, ~5–15 events per run, **never the shell firehose**). The card is simply *another projection surface for the run*, exactly as the Nostr thread is — and the out-of-sandbox **projector is the one bridge**.

| `run_event` | Card operation (authored by the agent identity) |
|---|---|
| `state → BUILDING` | `card_moved(To Do→In Progress)` + comment *"Picked up · cloning `acme/api` · reading the card"* |
| `pr_created` (+screenshots) | comment *"Opened PR #841"* + attach screenshots; `card_moved(→In Review)` |
| review `changes_requested` (per iter) | **one** summarized comment *"Review requested changes (iter 2/3) — addressing: …"* |
| `state → AWAITING_HUMAN` | `card_moved(→Needs Approval)` + comment *"Ready to merge PR #841. Approve?"* + render Approve/Request-changes |
| merged | `card_moved(→Done)` + comment *"Merged ✔ · closes this card"* |
| `ESCALATED`/`FAILED` | `card_moved(→Blocked)` + `needs-human` label + comment with the reason |

**Authorship & the security boundary.** Card moves and comments are authored by the **agent's identity** — and written by the **out-of-sandbox projector, never the sandbox** (the platform's rule: the agent's signing key never enters the user-tamperable VM). In the MVP the projector writes the card rows attributed to the agent; when the Nostr wrap lands (platform Phase 2), the **same** projector additionally signs each `card_moved`/comment as a NIP-10-on-kind-9 event under the agent's npub — so the board works without Nostr and gains signatures without a rewrite.

**Idempotency (replay/at-least-once safe).** Each projected card mutation is keyed on the originating `run_event`'s `(run_id, seq)`: `dedupe_key = run:{runId}:{seq}`, unique per board. A replayed transition or duplicate webhook never double-moves the card or double-posts a comment — the same discipline as `run_events` and `nostr_event_index`.

**Evidence** rides the platform's blob path unchanged: bytes leave the sandbox → Blob (or NIP-96, sha256-addressed) → referenced by hash from an attachment activity row, with the long-retention rule for PR-embedded images.

---

## 4. Human approval

The card in **Needs Approval** renders **Approve** and **Request-changes**. These resume the `wait-human` pause — but **a card button click is never trusted from the client** (the platform's "signature ≠ authorization"):

```
POST /api/boards/cards/:cardId/approve      // or /request-changes  { comment? }
  1. actor is authenticated (Clerk session, or a signed approval event in the Nostr path)
  2. actor holds the APPROVER role            (nostr_identities.is_approver / RBAC)
  3. R8 RE-CHECK against GitHub identity       (linked GitHub user still holds ≥ push on the PR's repo)
  4. only now: resumeHook(`human:${runId}`, { decision })     (idempotent on hook_token → double-click merges once)
```

- **Approve** → resume `wait-human` → `READY_TO_MERGE → MERGING` → GitHub App merge → `DONE` → `card_moved(→Done)`.
- **Request-changes** `{comment}` → resume → `REVIEW_FEEDBACK` → **additive-scoped** `followUp()` to the same session/branch ("address ONLY these") → `wait-push` → re-review; the card slides **Needs Approval → In Review**, and the human's comment is the feedback.

The card button is just a second surface over the *identical* gate the platform already uses for in-thread approval.

---

## 5. The data model

**What is reused, not rebuilt.** The Trello build derived an 8-table model whose first three — users, organizations, memberships — the platform already has via **Clerk** (magic-link + OAuth, **never passwords**). So this module does **not** invent a new org or membership table. Organization = **Clerk org** (bound to the NIP-29 group via the existing `workspace_bindings`); invites use **Clerk's native org invitations**; a **member/assignee is a typed pair** so it can be a human *or* an agent with zero new identity plumbing.

```sql
-- org = Clerk org (exists); a member/assignee is an identity: human OR agent
-- typed-pair handle used everywhere a card references a principal:
--   (member_kind ∈ {'human','agent'}, member_id → users.id | agent_identities.id)  + CHECK

boards      (id PK, org_id, name, slug, kind text,               -- kind: 'agent' | 'plain'
             is_agent_board bool, bound_repo text,               -- owner/name; required to trigger runs (MVP: single repo)
             created_by, archived_at, created_at, updated_at,
             UNIQUE(org_id, slug))

columns     (id PK, board_id→boards ON DELETE RESTRICT, name, position text,
             kind text,                                          -- todo|in_progress|in_review|needs_approval|done|blocked
             run_state_role text,                                -- agent boards only; frozen map to shipRun states
             wip_limit int, created_at)

cards       (id PK, board_id→boards ON DELETE RESTRICT,
             column_id→columns ON DELETE RESTRICT,               -- ★ RESTRICT: empty the column before deleting it
             title, body md, position text,                     -- LexoRank fractional rank, NOT an int
             active_run_id→runs,                                 -- correlation (§2)
             created_by, archived_at, created_at, updated_at)

card_members(card_id→cards, member_kind, member_id)              -- many-to-many; NEVER an array column
card_labels (card_id→cards, label_id→labels)                    -- (labels/card_labels deferred past MVP)

-- the append-only spine: audit + live stream, mirrors session_events
board_events(seq bigserial PK,                                   -- global monotonic; the LWW arbiter
             event_id text UNIQUE, board_id, type,
             actor_kind, actor_id, actor_npub,
             dedupe_key text,                                    -- client-ULID (human) OR run:{runId}:{seq} (projector)
             data jsonb, ts,
             UNIQUE(board_id, dedupe_key))
```

**`board_events` is the append-only truth; the relational `cards`/`columns`/comment tables are the read-model, written in the *same transaction* as each event** — exactly mirroring the platform's `session_events` (truth) + `messages` (materialized convenience view) split. One transactional writer keeps them consistent.

**Referential integrity — the transcript's rules, kept:**
- **`column → card` is `ON DELETE RESTRICT`, not CASCADE** (the S3-bucket analogy: force the admin to empty a column first — a `409`, not silent data loss — so an accidental delete never wipes issues).
- **Comments cascade** on card delete (they are dependent). But **any card that has triggered a run is soft-deleted / tombstoned only** — hard delete orphans the run↔card link and punches holes in the append-only audit trail.
- **Never store composite/array FKs.** A card's assignees are rows in `card_members`, never an array column — the transcript's normalization lesson, applied.

**API surface** (the transcript's CRUD, plus the agent verbs). The two hygiene rules from the build: **the accept/mutation endpoints take `org_id`/`card_id` only — the actor id always comes from the session/JWT, never the request body** ("never take user_id as input — that's how sites get hacked"); and the **list endpoint returns title + a truncated description (top ~50); the single-card endpoint returns the full body + all comments** (don't overwhelm the backend).

| Endpoint | Purpose |
|---|---|
| `GET /boards/:id` (+ resumable activity stream) | board + columns + cards (truncated) |
| `GET /boards/:id/cards/:cardId` | full card + comments |
| `POST /boards/:id/cards` · `PATCH /cards/:id` · `PATCH /cards/:id/move` | create / edit / within-column reorder (human) |
| `POST /cards/:id/solve` | **the trigger** (§2) — assignment/Solve/drag all converge here |
| `POST /cards/:id/approve` · `/request-changes` · `/cancel` · `/continue` | the `wait-human` gate + Blocked recovery (§4) |
| `POST /cards/:id/comments` | human comment |
| Clerk-native | create-org, invite, accept, remove-member |

No new webhook surface — completion still arrives on the platform's existing `pull_request` / `pull_request_review` / `check_suite` bus.

---

## 6. Real-time

The platform already made the transcript's *"do you even need WebSockets?"* decision and answered **"no — use a server-push stream (SSE)."** So live card updates and presence slot into the split the platform already drew.

**Live card updates → the durable event log + resumable SSE.** A card event is the *same class of event as an agent milestone*; "a human moved a card" and "the agent moved a card" are **one stream**. The wire frame is identical to a run milestone — flip `actor.kind` to `"agent"` and the same frame means "the bot moved the card," no second code path.

- **Decoupled from any run.** A board takes writes from many humans + several concurrent runs, so the board SSE must **not** be tied to one workflow's stream (that would re-introduce the platform's flagged "`/messages` can't write into the WDK stream" bug — as the *common* case). Instead: `emit()` is one transaction (`INSERT board_events` + a Redis `PUBLISH board:<id>`), and `GET /boards/:id/stream` replays `board_events WHERE seq > Last-Event-ID` then tails the Redis channel. Refresh-safe by construction, bit-identical on reconnect — the exact session-SSE component, reused.
- **One global `bigserial seq`**, streamed filtered by `board_id`, sidesteps per-board seq contention; `Last-Event-ID` is a simple global cursor.

**Conflict resolution — last-write-wins, and it's already built.** Per the transcript: for a Kanban board, LWW is correct; **do not implement locking** (the movie-ticket anti-pattern) and **do not reach for CRDTs** (Trello is not Google Docs). The gift from the platform: LWW *falls out of the append-only log for free* — fold `board_events` in `seq` order and the last `card_moved` wins the column+`pos`. Two people drag the same card at once → two events, higher `seq` lands, everyone converges because everyone reduces the same ordered log. The reducer is a **shared package with golden tests**, and the optimistic client path calls the *same* reducer so a reconciled echo is bit-identical.

**Optimistic UI + the client-vs-server ID tension.** The client mints a **ULID as the card's business id**, renders instantly, and sends it; the server treats it as an opaque handle, assigns the authoritative `seq`, and echoes the same ULID so the optimistic card reconciles by id. *"Never trust the client id"* is honored because the ULID is a **random opaque handle, not a capability** — the server still authorizes the actor, owns ordering, and scope-checks the ULID to the org/board; it derives nothing security- or order-relevant from it. Bonus: the ULID doubles as the create's **idempotency key**, so a retried create is a dedupe no-op, not a duplicate card.

**Presence → ephemeral, bound to the SSE connection lifecycle (no separate WebSocket).** The transcript's iron rule — *you cannot store the socket in a database; leave is detected by connection close, never a client "leave" message* — is honored over SSE, because an SSE connection *is* a live connection whose close the server detects:
- **Join** = the board SSE stream opens → write `presence:<board>:<member>` to Redis (`SET PX <grace>`), publish a fresh roster as an `event: presence` frame.
- **Leave** = the stream's server-side cancel/abort fires (tab or network death) → deregister → republish roster. A client-sent leave is still never trusted. Hard tab-death is caught by **TTL expiry**, so presence self-heals.
- **Durable vs ephemeral is enforced by the framing itself:** card events carry `id:<seq>` (resumable); presence frames use `event: presence` and carry **no `id:`**, so `EventSource` never tries to "resume" ephemeral state. A 500-viewer board reshuffling avatars 100×/s writes **zero** rows to `board_events`.
- **Agent presence is run-derived, never a faked heartbeat** — an agent holds no browser tab, so a linked active `shipRun` renders the agent's avatar with a "working" ring, sourced from run state (no ghost agents when a run dies).
- **Scale escape hatch, honestly:** when large boards truly need sub-second cursors/typing, stand up the transcript's exact design — a stateful WS node with an in-memory room `Map`, scaled by multiple nodes + Redis pub/sub (PartyKit / Durable Objects / Supabase Realtime). This is the very statefulness the SSE-first architecture avoids; adopt it only when board size forces it, not day one. **Presence is deferred out of the agent-board MVP entirely** — who's-viewing avatars aren't load-bearing to "a card is picked up by an agent and shipped as a PR."

**Polling is an honest fallback.** For Trello, polling `GET /boards/:id?since=<seq>` every ~2s is genuinely fine (a few seconds' delay to see a coworker's move doesn't matter); it's the graceful degradation where SSE is blocked.

---

## 7. Transcript lessons we kept

Beyond the architecture, the build is a compact catalog of correct instincts, all folded in above:
- **Teams-first / orgs are first-class** — no solo usage; you always create or join an org after signup. (Maps to Clerk orgs.)
- **Auth is magic-link / OAuth, never passwords.**
- **Many-to-many always gets a third join table** — never an array/composite FK (applied to `card_members`).
- **`ON DELETE RESTRICT`** for column→card (empty the bucket first; 409, not data loss).
- **Never take `user_id` as request input** — derive the actor from the session.
- **List vs detail** — truncated list (top-50), full body + comments on the single-card endpoint.
- **Invites are a two-way handshake** — but we get it free from Clerk instead of building `pending_memberships`.
- **Presence can't live in a database; LWW beats locking; polling is honestly fine** — all reconciled to the platform's SSE-first model.

---

## 8. Frozen decisions

*The three module designs contradicted each other (and the platform) on nearly every shared seam. These are canonical — freeze them before any migration.*

| Contested seam | **Canonical decision** |
|---|---|
| **Organization** | **Clerk org** (already exists), bound to the NIP-29 group via `workspace_bindings`. **No new org/membership table.** Drop `org_members` and `pending_invites`; use Clerk's native invitations. |
| **Member / assignee** | **Typed pair** `(member_kind ∈ {human,agent}, member_id → users.id \| agent_identities.id)` with a CHECK. Works pre- and post-Nostr. |
| **Entity naming** | **card / column** (not `board_issues`/`board_sections`). `IssueTracker.getIssue` maps to a card. |
| **Card ↔ run correlation** | **Direct FK** `runs.card_id` + `cards.active_run_id` + `one_active_run_per_card` partial unique index. `external_refs` stays for external ids only. |
| **Board live event log** | **One `board_events`** (board-scoped, global `bigserial seq`, resumable `id:<seq>` SSE), `UNIQUE(board_id, dedupe_key)` where `dedupe_key` = client-ULID (human) or `run:{runId}:{seq}` (projector). |
| **Card/comment data home** | `board_events` = append-only truth; relational `cards`/`columns`/comment tables = read-model, written in the **same transaction**. |
| **Run trigger** | **Explicit Solve is the single authorization point.** Drag-to-column is sugar over the same `/solve`. Assignment only stages. Auto-dispatch = opt-in per-board policy. Every path: authorship → binding → **R8 re-check** → `needs_human_review` → budget/concurrency caps *before* a sandbox boots. |
| **Columns** | **By board type.** Agent board (`kind='agent'`): fixed run-state columns, frozen golden-tested map, unmapped state → **Blocked** (fail-safe). Plain board: dynamic sections. **MVP = agent board only.** |
| **Stream transport** | **Resumable SSE over Postgres** (tail `board_events` by global seq, decoupled from any run, keyed on `board_id`). **Redis scoped to presence only.** |
| **Presence** | SSE-connection-lifecycle (join = stream open, leave = cancel/TTL), ephemeral Redis, agent presence run-derived. Frames carry **no `id:`**. **Deferred out of the MVP.** |
| **`position`** | **One shared LexoRank contract** (+ card-id tiebreak + periodic rebalance) imported by both CRUD and realtime. |
| **Delete** | **Soft-delete / tombstone** for any run-triggered card. `ON DELETE RESTRICT` (force-empty, 409) for column delete. |
| **Multi-repo** | **MVP = single `bound_repo` column.** `board_repos`/`card_repos` join tables are the deferred multi-repo seam. |
| **IssueTracker** | One `BoardIssueTracker implements IssueTracker`; `runs.source += 'board_card'`. The keystone. |

---

## 9. Roadmap

Boards is a **conventional (non-Nostr) trigger + projection surface over `shipRun`.** Two consequences fix its place in the platform roadmap: (a) it must land **after platform Phase 1** — you can't drive a card through `shipRun` columns until `shipRun` exists; (b) it is **not gated on Nostr** — it works pre-Nostr and gains agent-npub signatures additively in Phase 2, from the same projector, exactly like every other surface.

**Go agent-first, not Trello-clone-first.** The differentiator is the agent bridge (mostly reuse of `shipRun`); the human Trello breadth (dynamic columns, labels, multi-assignee, drag-reorder, presence, invites) is table stakes competitors already have and is **not** the wedge. So prove the unique value end-to-end first.

| Board phase | Platform slot | Content |
|---|---|---|
| **Board 0 — schema freeze** | end of platform Phase 1 | Freeze the §5/§8 reconciled schema: `boards`/`columns`/`cards`, one `board_events` log, typed-pair member handle, `runs.card_id`+`cards.active_run_id`+`one_active_run_per_card`, `runs.source+='board_card'`, the frozen column↔state map (golden test), one LexoRank `position` contract. **No new org/membership/correlation tables.** |
| **Board A — the unified-value MVP** | **Phase 1.5** (after the money-loop is real; don't block the Phase-1 dashboard proof) | Minimal agent board end-to-end: create card → **Solve** (full auth chain + R8 + `needs_human_review`) → `BoardIssueTracker` drives columns from `run_events` (projector, idempotent on `run:{runId}:{seq}`) → **Approve** in-column (re-auth) → merge → Done. Resumable SSE over `board_events`, single-writer-per-lane, soft-delete only. One repo, one Clerk org, fixed columns. **No presence, no invites, no dynamic sections, no multi-repo.** Ship the golden replay test as the contract. |
| **Board B — collaboration polish** | with/after **Phase 2 (Nostr wrap)** | Projector *additionally* signs `card_moved`/comments under the agent npub (NIP-10-on-kind-9) — additive, no rewrite. Human presence (Redis + SSE-lifecycle). Optimistic client-ULID drag. Human comment threads. Reconcile cron for card↔run drift. |
| **Board C — breadth / scale** | **Phase 3–4** | Dynamic sections + plain boards; multi-repo per board; labels; board-scoped permissions; dedicated WS presence tier (PartyKit/DO/Supabase) only if board size forces it; the full human Trello surface. |

**MVP demo:** paste a task into a card, click Solve, watch the agent avatar light up and the card walk itself To Do → In Progress → In Review → Needs Approval, click Approve, watch it merge and slide to Done — and see a vague card get refused into Blocked before it ever burns a run.

---

## 10. Top risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Board-as-trigger authorization / money burn.** Assign or mass-Solve silently seeds N unbounded `shipRun`s. | **Explicit Solve is the sole spend-authorization point** (assign only stages; drag = sugar over `/solve`). Full chain before any sandbox: binding → **R8 re-check** → `needs_human_review` refusal into Blocked → per-board/per-org/**per-card** concurrency + iteration caps (review 3 / build 4). `bound_repo` required. Intent ≠ authorization. |
| 2 | **Event-log / correlation split-brain.** Card state disagreeing with run state; double-moves on replay. | **`run_events` is SoR; the card is a projection.** One `board_events` log; the out-of-sandbox projector is the *only* writer of agent-authored card events; every mutation dedupes on `run:{runId}:{seq}`; one correlation store (direct FK); a reconcile sweep re-derives a card's column from the run's terminal state if an event was dropped. |
| 3 | **Dual-writer race on a card** (human drag vs. agent projection at once). | **Single-writer-per-lane:** while `active_run_id` is set the run owns To Do…Done; human cross-column drags snap back; only within-column reorder + control actions allowed. **LWW falls out of the seq-ordered reduction** — no locks, no CRDT. |
| 4 | **Columns-as-states coupling brittleness.** `shipRun` evolves → a new/renamed state silently mis-projects. | The `column.kind ↔ run_state` map is a **single frozen table + a golden replay test** (record a full run's events, assert the exact column path + comment set); an unmapped state **fails safe to Blocked**. Coupling scoped to agent boards only. |
| 5 | **Real-time scaling on Vercel/Fluid Compute.** Many-writer board can't ride one WDK run stream; Vercel is hostile to stateful WS; stream recycle looks like presence flap. | Board SSE fans out from a **per-board Postgres tail keyed on `board_id`** (global `bigserial seq`, `id:<seq>` resume), decoupled from any run — reuse the session SSE component. Presence = **ephemeral Redis** bound to SSE lifecycle, TTL/grace > recycle, presence frames carry **no `id:`**. Dedicated WS tier is a documented escape hatch, not day one. |

---

### One-paragraph summary
Add a native Kanban board whose columns *are* the master loop's states: a card is `shipRun`'s native ticket (`runs.source='board_card'`, correlated by a direct `card_id`/`active_run_id` FK), clicking **Solve** runs the platform's full authorization chain and starts a run, and the out-of-sandbox projector walks the card To Do → In Progress → In Review → Needs Approval → Done while posting ~5–15 milestone comments — with Approve/Request-changes as re-authorized `wait-human` card buttons and Blocked as a real column for escalations. Reuse Clerk for orgs (a member is a typed human-or-agent pair, so agents are assignees for free), one append-only `board_events` log as the read-model's truth, resumable SSE over Postgres for live updates (last-write-wins falls out of the ordered log — no locks, no CRDTs), and ephemeral Redis-over-SSE for presence. Keep the transcript's data-model discipline (third join tables, `ON DELETE RESTRICT`, never trust the client's `user_id`, soft-delete only), go **agent-first** on a minimal fixed-column board rather than building a Trello clone first, slot it at **Phase 1.5** (after the money-loop is real, not gated on Nostr), and guard the whole thing with a golden replay test that pins the column↔state projection as a contract.
