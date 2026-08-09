# Front-End Plan — the supervision UI

*How the platform's web front-end is structured, what it looks like, and why. It sits over the fixed back-end in `SYSTEM_PLAN.md` (durable runs, the event log, GitHub-as-verdict-bus, R8 authorization). Two visual mocks accompany it: a first board-first pass, and the **inbox-first** correction this plan adopts.*

**The thesis, in one line:** the operator's daily job is **triage across many parallel agent runs — "what needs me right now?"** — which is *inbox-shaped, not board-shaped.* So **home is a triage Inbox**, and the **Board, Threads, and Run-detail are views** onto the same runs. Every surface is a pure projection of one event log, so this is a smarter default *lens*, not a new data model.

**How to read it.** §0 pins the canonical vocabulary, the honest inbox-first argument, and the corrected build slice — **where any section below drifts on a name or a decision, §0 governs.** Then six sections: **Information architecture → Inbox → Run-detail → Board & Threads → Notifications → Component & state system**.

---

## 0. Canonical decisions & corrected MVP

*The six sections were drafted independently and diverged on nouns (state names, component names, the event envelope, selectors, routes) and on where approval is safe. These calls are canonical.*

### Inbox-first — right default, honestly framed

Inbox-first is the **correct default for the target operator** (dozens–hundreds of parallel runs, approvals in-app, act-now work). But state the argument precisely and don't over-claim:

- The strong, honest claim is **not** "queues scale, boards don't" — a board *could* rank within columns. It is: **triage needs within-set priority, and a Kanban column has no native ordering.** Retrofit ranking into a board and you've built a queue-with-columns anyway.
- **Home is a per-user preference, not a fixed product opinion.** Inbox is the default; the view switcher + a per-user "home surface" setting make Board or Threads a *config*, not a rewrite. This kills the only real contradiction in the draft (IA treated the board as a liability; Board & Threads re-humanized it — the preference framing reconciles them).

**Flip the default only when *all* hold:**

| Condition | Inbox-first | Board-first | Thread-first |
|---|---|---|---|
| Concurrent runs / operator | dozens–hundreds | a handful | a handful |
| Primary job | act / triage | plan + monitor | converse / delegate |
| Where approvals happen | in-app | Slack / GitHub | Slack |
| Primary user | operator | stakeholder / PM | chat-native IC |

### One vocabulary (adopt; delete the aliases)

- **Run state = the platform's frozen `run_state`** (`SYSTEM_PLAN.md` §2), *not* a forked front-end enum: `QUEUED · BUILDING · REVIEWING · REVIEW_FEEDBACK · AWAITING_HUMAN · MERGING · DONE`; off-ramps `ESCALATED · CANCELLED · FAILED`. The reducer keys on these values. The **UI presents friendly labels** over them — the map is fixed here:

  | UI label | `run_state` |
  |---|---|
  | To do | `QUEUED` |
  | Working | `BUILDING` |
  | In review | `REVIEWING` · `REVIEW_FEEDBACK` |
  | **Needs approval** | `AWAITING_HUMAN` |
  | Merging | `MERGING` |
  | Done | `DONE` |
  | **Blocked** | `ESCALATED` · `FAILED` |
  | Aborted | `CANCELLED` |

  `severity` (`active · good · warn · critical`) is a **separate field**, not a state. Sections that wrote `IN_REVIEW`/`NEEDS_APPROVAL`/`BLOCKED`/`MERGED`/`aborted` mean the mapped `run_state` above.

- **Components — one name each.** `<RunObject variant="row|card|header">` is the atom (an inbox row, a board card, a run header are three *densities* of it — **state is a prop, not a variant**); `<InboxRow>`/`<RunSummary>` are deleted or thin wrappers. `<StateChip>` renders the label+severity. **`<ApprovalPanel>` is the one approval surface** — Threads renders it inside a message shell; `<FocusedApproval>` wraps it for mobile; the Inbox's inline "peek" renders a *compact* `<ApprovalPanel>`, not a bespoke thing (delete `<ApprovalCard>`).

- **Event envelope — one shape the reducer consumes:** `{ seq: number, runId: string, type: EventType, at: string, payload: {…} }`. Every event carries `seq` (drives `Last-Event-ID`, ordering, gap-detect). **State is DERIVED** by folding domain events (`ci.result`, `review.round`, `run.blocked`, …) — there is **no `run.state_changed` event**; the board re-renders because the *derived* `state` on the run changed in the store, exactly like every other projection.

- **Selectors — one signature each:** `selectInbox(store,{filters,ranker}) → { needsYou, inFlight, recentlyShipped }` (banded, not a flat array); `selectBoard`, `selectRunDetail`, `selectThread`. `selectActionQueue` is deleted — the in-app notification queue *is* `selectInbox(...).needsYou`.

- **Routing — single source of truth:**

  | Route | Surface |
  |---|---|
  | `/` | renders the user's home surface (default **Inbox**); no redirect |
  | `/inbox` · `/board` · `/threads` · `/threads/:channelId` | the three lenses (threads are **channel-shaped**; drop the per-run `/runs/:id/thread`) |
  | `/runs/:id` | Run-detail — **drawer overlay *and* full page**, one spelling (plural) |
  | `/approve/:runId` | focused mobile approval (notification deep-link target) |
  | `/members` · `/connections` | directory + config |

- **Keymap — one canon:** `j/k` move · `Enter`/`e` open · `a` approve · `r` request-changes · `c` continue (Blocked) · `x` abort. Drop the invented `b`=block and `x`=archive (a human doesn't "block" a run; there's no archive action). Blocked-run copy is **Continue / Abort** everywhere (not "Unblock").

### R8 — two checks, never trust the client

- **Client R8** = an *optimistic UX pre-check*: re-read the run and compare `(runId, headSha, verdictId, run_state)` before enabling the button; it shows `stale`/`guarded` and prevents obviously-dead clicks. **It is never the gate.**
- **Server R8** = the authority, re-run at approve-time on the signed action (the linked GitHub user must still hold ≥ `push`). The merge happens only if server R8 passes. A stale or forged nudge resolves to `already-handled`, never a live merge.
- **The run object must carry `headSha` and `verdictId`** (add to `RunState.approval`) or client R8 has nothing to bind to.
- The Inbox "locked" row (someone else is approving) is built on **presence, which may lie or vanish** — frame it as a *soft hint*, not a correctness guarantee; the real double-approve guard is server single-fire + R8.

### The corrected MVP (better than "Inbox + inline approve")

**Inline approve is the riskiest sub-feature in the plan** (rubber-stamping, staleness under a live reordering list, scroll-freeze, the `locked` state). So it is **not** in the MVP. The thinnest true money-loop is **Inbox (read + rank + filter) → Run-detail → approve *in Run-detail***: approval always has full context, which *dissolves rubber-stamping for free* and proves the store/SSE/server-R8 plumbing on a **stable page** before doing it inside a live list. And **notifications can't be deferred to the end** — "delegate and walk away" is a lie if the operator must poll — so a *thin* notify ships in MVP.

| Phase | Ship |
|---|---|
| **MVP** | `@ship/reducer` + snapshot + resumable-SSE + gap-detect; `selectInbox`/`selectRunDetail`; `<RunObject>`, `<StateChip>`, `<ApprovalPanel>`; tokens + both themes. **Inbox (read/rank/filter) + Run-detail + approve-in-Run-detail** (server R8, optimistic `clientTxnId`). **Thin notify:** email + in-app badge on `AWAITING_HUMAN`/`ESCALATED` → `/runs/:id`. The **golden-test harness** (`fixtures/*.jsonl` → asserted projection snapshots, incl. blocked/retried/force-pushed/superseded) exists **now**, not later. |
| **1.5** | **Inline approve in the Inbox** (in-row peek, client-R8 pre-check, focused-row scroll-freeze, `locked` soft hint, guided-sequential review). The genuine risk surface, added only after the plumbing beneath it is trusted. |
| **2** | **Board** (`selectBoard` — derived, no new event; virtualized columns; default filter = my runs). Ships the **second money moment** — the Solve/start-run click — with a shared `<ConfirmStart>` (currently unowned; it lands here). |
| **3** | **Threads** (`selectThread`, composer, `@mention` → the same `<ConfirmStart>`; renders `<ApprovalPanel>` in a message shell). |
| **4** | **Full notifications + mobile** (routing matrix, coalescing, `/approve/:runId`, PWA push, time-to-approve dashboard). |

Front-end for the platform's Phase-1 money-loop = **Inbox + Run-detail** on a conventional surface (no Nostr). Board is the platform's Phase-1.5 demo surface; Threads arrive with the Phase-2 Nostr wrap.

### The highest-leverage risk (build the harness for it in MVP)

The **snapshot↔tail seam** — exactly-once projection across "snapshot at N, stream from N+1," gap-detect → re-snapshot, idempotent optimistic reconcile on echo/reject — is where duplicate/missing-event and phantom-merge bugs hide. One normalized store, all surfaces pure selectors, **zero surface-local run state**, optimistic writes via `clientTxnId` that snap back *store* state (not a DOM node), and the checked-in golden fixtures are the mitigation.

---

## Information architecture & navigation

The app has **one home — the Inbox** — and three lenses onto the same underlying runs: **Board**, **Threads**, and **Run-detail**. This section fixes the shell, the nav, the routes, and the load-bearing reason the queue beats the board as home. Row anatomy, approval flow, and the client store are owned by their own sections; here I only wire them together.

### The atomic unit: the run object

Everything on every surface is a projection of one object — the **shipRun**. An inbox row, a board card, and a thread task are **three renderings of the same run**, not three data types. This is the whole IA in one sentence: surfaces are *views*, runs are *state*. Consequences the rest of the plan can rely on:

- Selecting a run in one surface selects it everywhere (shared selection in the client store).
- Filters/scope are defined once over the run collection and reused by all three surfaces.
- "Unread," "needs-you," and "blocked" are properties of the run, computed once — a badge in the rail, a red rail on a card, and a bold inbox row are the *same* signal styled three ways.

If a surface needs a field the run object doesn't carry, that's a run-object question, not a per-surface one.

### The shell

Three zones, stable across every route:

```
┌──────────┬───────────────────────────────────────┐
│  LEFT    │  [ Inbox | Board | Threads ]  ⌘K   ⚙  │  ← main header: view switcher
│  RAIL    ├───────────────────────────────────────┤
│  (nav)   │                                       │
│          │        active surface (main)          │
│          │                                       │
│          │                    ┌──────────────────┤
│          │                    │  run peek drawer │  ← /runs/:id overlay (opt.)
└──────────┴────────────────────┴──────────────────┘
```

- **Left rail** — persistent global navigation and org context (below).
- **Main column** — the active run surface; its header holds the view switcher.
- **Run peek** — a right-side drawer that overlays *any* surface when you open a run without leaving the queue (see Run-detail below). The drawer's internals are owned by the Run-detail section.

### Left rail

Fixed order, grouped by kind so the run surfaces never mix with config:

1. **Org switcher** (top) — button showing org name + avatar; opens a menu of orgs and "New org." Org is the top scope for everything below.
2. **Run surfaces** (primary nav):
   - **Inbox** — home. Carries the only count in the rail: a **needs-you badge** (`aria-label="Inbox, 7 need you"`). The badge counts *only* runs in the two loud states — **Needs Approval** and **Blocked** — never "building," "in review," or "merged." That restraint is what keeps the number meaningful.
   - **Board**
   - **Threads**
3. — divider —
4. **Directory & config:**
   - **Members** — humans **and** agents in one directory (a run's assignee/author can be either; the directory treats them uniformly — owned by the Members section).
   - **Connections** — GitHub, Slack, sandbox providers, and other integrations.
5. **Bottom** — user avatar menu, theme toggle (theming section), `⌘K` command-palette hint.

Rail behavior: `aria-current` on the active destination, `<nav>` landmark, collapsible to icons on narrow widths. Board and Threads deliberately carry **no red counts** — calm-by-default means only Inbox is allowed to shout, and only for the two human moments.

**Primary:** flat rail, five destinations. **Alternative:** fold Members/Connections into a single "Settings" area — tidier rail, but one extra click to the two things operators actually reconfigure (who's on the team, what's connected).

### View switcher

A segmented control in the main header — **`Inbox | Board | Threads`** — distinct from the rail. The rail is for *cold entry*; the switcher is for *warm flipping*: it **preserves the active filter, scope, and selected run** as you move between lenses. Triage in the Inbox, hit Board to see the same filtered set spatially, flip to Threads to read the conversation — same runs, three shapes, nothing re-typed.

The switcher covers **only the three run projections**. Members and Connections are not runs, so they're rail-only and never appear in the switcher. Keyboard: `g i` / `g b` / `g t` jump between the three; the switcher is a `role="tablist"` with the surface as its panel.

**Primary:** switcher preserves filter + selection across all three. **Alternative:** treat the three as fully independent destinations (no carried state) — simpler to build, but it hides that they're one dataset and forces operators to re-filter three times.

### Route map

| Route | Surface | Notes |
|---|---|---|
| `/` | → redirect to `/inbox` | home is the queue |
| `/inbox` | Inbox (triage home) | default landing; needs-you sort |
| `/board` | Board (columns = run states) | planning/backlog + spatial monitoring view |
| `/threads` | Threads (chat) | conversation lens on runs |
| `/runs/:id` | Run-detail | deep-linkable canonical page **and** the drawer target |
| `/members` | Members (humans + agents) | directory |
| `/connections` | Connections | integrations/settings |

`/runs/:id` is dual-natured on purpose: it's a **shareable full page**, and opening a run from any surface pushes it as a **modal route** (drawer with URL sync) so the queue stays behind it. Back closes the drawer; an "Open full page" affordance escapes to the standalone route.

**Primary:** run-detail as route + overlay drawer. **Alternative:** full-page route only — zero back-button ambiguity, but every run inspection yanks you out of the queue you're triaging. Org scope stays in client state for MVP (rail switcher), not in the URL; see risk 5.

### Why Inbox-first, not Board-first

The core decision, argued so later sections can lean on it:

- **The job is triage, not observation.** The operator's real question is *"what needs me right now?"* across many parallel agent runs. That's a **prioritized queue** — one ranked list you burn down — not a spatial layout you scan.
- **It scales with run count.** At dozens–hundreds of concurrent runs a board breaks down: columns overflow, cards are **unordered within a column**, and there's no notion of "this one first." A queue ranks; a board only groups.
- **Work is notification-driven.** Runs summon the operator via events (*Needs Approval*, *Blocked*). The inbox is the on-screen twin of that ping stream; the board has no natural mapping to "you were just pulled in."
- **The board conflates two jobs.** *Planning* (what should we start / groom the backlog) and *monitoring* (what's happening now) want opposite layouts, and one column arrangement can't serve both. The Inbox is unambiguously the *monitoring / act-now* surface.
- **Columns-are-states is a great view but a risky foundation.** A card walking left-to-right through its states is legible and demos beautifully — keep it as a *view*. But as the *home* it hard-codes the pipeline's state machine into the primary surface: change the back-end states and your homepage reshapes; and it structurally has **no within-state priority**, which is exactly the signal triage needs most.

### When Board-first would be the right call instead

Name it honestly — flip the default if:

- **Few concurrent runs** — a handful you can eyeball spatially, where ranking adds nothing.
- **Approvals happen elsewhere** — decisions land in Slack/GitHub, so the web app is a *monitoring dashboard*, not an action queue; then spatial overview beats a to-do list.
- **Planning-dominant teams** — groups that spend more time grooming what to start than reacting to live runs.

None hold for the target operator (many parallel runs, approvals in-app), so Inbox is home. If a deployment matches all three, the switcher already makes Board the landing with a one-line config change.

### IA risks

1. **Two homes drift.** If Board becomes a de-facto second home, its filters/sort must stay identical to Inbox's or the two tell different stories. *Mitigation:* one shared store + one filter model; surfaces can't hold private state.
2. **Inbox becomes a firehose.** The moment states beyond Needs-Approval/Blocked raise the needs-you count, the number stops meaning "act now." *Mitigation:* hard rule — only the two loud states count; everything else is ambient (milestone-not-firehose).
3. **Route/drawer duality confuses the back button.** `/runs/:id` as both page and overlay invites history ambiguity. *Mitigation:* strict modal-route pattern, explicit "Open full page," drawer close === history back.
4. **Rail bloat.** Members, Connections, Settings, Reports all want a slot. *Mitigation:* cap primary nav at the three run surfaces; everything else lives below the divider or under the account menu.
5. **Org lives in client state, not the URL (MVP).** Shared deep links may open in the wrong org. *Mitigation:* accept as known MVP debt; promote org to a URL segment (`/:org/...`) when multi-org sharing matters.
6. **State-enum coupling leaking into a primary surface.** If Board columns are generated 1:1 from the back-end state enum, a pipeline change silently reshapes a shipped surface. *Mitigation:* board columns are a client-owned *presentation mapping* over run states, not the enum itself.
7. **Switcher discoverability.** Users may not realize Inbox/Board/Threads are the same runs. *Mitigation:* carry selection across the switch and keep a quiet "same runs, different lens" cue so the equivalence is felt, not explained.
## 2. The Inbox — the triage home (the hero surface)

The Inbox lives at `/` — it is what you see when you open the product with nothing else in mind. Its one job is to answer *"what needs me right now?"* across every parallel `shipRun`, and to make everything else recede. It is a single prioritized queue rendered from the shared client store (the `Run` projection over the event log — owned by **§ Client data model**), via one derived selector:

```
selectInbox(store) → {
  needsYou:   { readyToApprove: Run[], blocked: Run[] },
  inFlight:   Run[],
  recentlyShipped: Run[]
}
```

Everything below is a view of those same objects; the Kanban board, Threads, and Run detail (**§ Views & navigation**, **§ Run detail**) read the identical store, so the Inbox never owns state — it owns *ranking and triage affordances*.

### The three bands

The page is `<Inbox>` → three `<InboxBand>` sections, always in this fixed order. Only the top band is allowed to be loud; the rest is calm-by-default.

**Band A — NEEDS YOU** *(the only loud band; the two human moments live here)*
- **Ready to approve** — runs at `AWAITING_HUMAN`. Each row is a *mini run-summary*, not a bare line: the verdict, the green checks, and inline actions. This is the densest, most deliberate row in the product (spec below).
- **Blocked** — runs at `ESCALATED`. Each row leads with the human-readable reason and offers `Continue` / `Abort`. Example: *"Needs a secret — `STRIPE_KEY` not present in sandbox. Add it and continue, or abort this run."*

Band A carries the app's badge count and is the only place we use the alert color from **§ Design system**. If Band A is empty, the loudness budget is spent nowhere — the whole screen goes quiet.

**Band B — IN FLIGHT** *(calm; milestone-not-firehose)*
Running runs as compact status rows — **no actions**, click to open. Fields: state chip (`REVIEWING`, `BUILDING`, `RUNNING`), progress (mono, e.g. `review 2/3`), agent avatar, elapsed (`12m`). No streaming logs, no per-commit chatter — that firehose belongs to **§ Run detail**. A row here changes at most a few times over its life (state transitions), so the band is glanceable, not twitchy.

**Band C — RECENTLY SHIPPED** *(muted)*
Merged runs, low-contrast, collapsed to the last ~10. `merged 3m ago · a3f9c1 · #4821`. One action on hover: open. This band exists for reassurance and undo-adjacent recovery ("did that actually land?"), not for work.

### Ranking & sort

**Primary (MVP):** `needs-you first, then oldest-first within each band`. Ready-to-approve and Blocked sort by *wait time descending* so the run that has been starving longest floats up — legible, ungameable, and it surfaces SLA risk naturally (a row past threshold turns its age amber). The sort key is shown in the band header (`sorted by wait time`) so the order is never a black box.
**Alternative:** a weighted score blending age + repo priority + blast radius. *Tradeoff: smarter triage, but opaque — operators have to trust an order they can't see, which erodes exactly the top-down confidence the queue depends on.*

### Filters & scope

A single filter bar pinned under the header: **Repo**, **Agent**, and a **Mine** toggle (runs whose approver is you). Filters are scope, not sort — they narrow every band at once and are reflected in the URL (`/?repo=web-app&mine=1`) so a filtered inbox is linkable. `/` focuses the filter bar. Cross-reference **§ Views & navigation** for the shared filter component; the Inbox just consumes it.

### Empty states

Empty is a feature here, not a fallback — a quiet inbox is the product *working*.
- **Band A empty:** *"Nothing needs you. 7 agents working."* with a faint link *"watch them"* → scrolls to In flight.
- **Whole inbox empty:** *"All clear. Start a run to get going."* with the new-run entry.
- **Filtered to empty:** *"No runs match this filter."* + `clear filter`.

The count in "7 agents working" is live from the store, so the reassurance stays honest.

### The inbox row component (spec)

One component, `<InboxRow variant>`, three variants. Fonts follow the house rule — **sans for human text, mono for machine tokens**.

| Field | Ready-to-approve | Blocked | In-flight |
|---|---|---|---|
| Title (sans) | task title | task title | task title |
| Provenance (mono) | `#4821 · web-app · @refactor-bot · a3f9c1` | same | same |
| Verdict | `Approved by review` + `✓ tests ✓ lint ✓ types ✓ 2 reviewers` | — | — |
| Reason (sans) | — | *"Needs secret STRIPE_KEY"* | — |
| State chip | `AWAITING_HUMAN` | `ESCALATED` | `REVIEWING` / `BUILDING` |
| Progress (mono) | diffstat `+128 −34` | — | `review 2/3` |
| Age (mono) | `waiting 8m` (amber past SLA) | `blocked 3m` | `12m` |
| Agent | avatar | avatar | avatar |
| Actions | `Approve & merge` · `Request changes` | `Continue` · `Abort` | none (click opens) |

**Row states:** `default` · `focused` (keyboard ring) · `hover` · `confirming` (inline peek open) · `loading` (approving/merging) · `success` (checkmark, then animates down into Recently shipped) · `stale` (R8 refusal — see below) · `error` (merge failed) · `locked` (someone else is approving; actions disabled, avatar of the other approver shown). A focused row *freezes its scroll position* while live events reconcile around it, so the queue never jumps under the cursor.

### Approving inline (the flow) — and how it stays safe

The whole point of the Inbox is that you can approve *without opening the run* — but never blindly. Inline approve is provenance-forward and re-authorized on every click (the platform's **R8** re-check invariant, **§ Client data model**).

1. **Trigger** — focus a Ready-to-approve row (`j`/`k`) and press `a`, or click `Approve & merge`.
2. **Peek, not modal** — the row expands *in place* into a `confirming` state showing the diffstat, verdict, and green checks, with copy: *"Approve `@refactor-bot`'s changes and merge to `main`?"* → `Approve & merge` · `Cancel`. The peek forces the verdict and diff into view; this is the anti-rubber-stamp friction.
3. **R8 re-check on confirm** — the client re-reads the run and validates the approval is still bound to the same `(runId, headSha, verdictId)` **and** `state === AWAITING_HUMAN`.
4a. **Valid →** optimistic `loading` ("Merging…"), dispatch the approve+merge mutation; on success the row shows a checkmark and slides into Recently shipped, and Band A's count decrements (announced in the live region).
4b. **Stale →** refuse and flip the row to `stale`: *"New commit since review (`a3f9c1` → `b7d2e0`). Re-review before approving."* The primary action becomes `Open to re-review`. No merge happens.
5. **Error →** inline, not lost: *"Merge blocked — branch out of date."* + `Open run`.

**Primary (MVP):** inline approve with the in-row peek + R8. **Alternative:** require opening Run detail to approve. *Tradeoff: strictly safer and higher-context, but it defeats the triage-in-a-queue premise and doesn't scale past a handful of runs.*

### Keyboard triage

The Inbox is drivable without a mouse:
- `j` / `k` — move focus down / up across rows.
- `a` — approve focused row → opens the peek; a **second** keystroke (`a` or `Enter`) confirms. Two deliberate presses, never a single-key merge.
- `r` — request changes · `e` / `Enter` — open run detail (`/runs/:id`).
- `c` — continue · `x` — abort (Blocked rows).
- `/` — filter · `?` — shortcut help · `Esc` — cancel an open peek.

There is intentionally **no "approve all" hotkey**.

### Bulk approve (deliberately awkward)

**Primary (MVP):** no true one-click bulk. Instead a **guided sequential** "Review queue" mode that walks Ready-to-approve one at a time — peek → approve/skip → next — so every merge still passes its own R8 check and a human glance. It feels fast without being a firehose of merges.
**Alternative:** multi-select + `Approve N selected`, gated behind a typed confirm (`type MERGE 4`) with a hard rule that *any* stale row in the selection aborts the whole batch. *Tradeoff: faster on trusted low-risk repos, but it manufactures the rubber-stamping the product exists to prevent.*

### Accessibility & theming (brief)

Bands are `role="list"`; rows `role="listitem"` with a labelled action group. Band counts and post-approve transitions fire through a polite `aria-live` region. Focus is managed on row removal (moves to the next row, never to `body`). Both themes are first-class; the alert color for Band A is defined once in **§ Design system** and never reused elsewhere, so "loud" stays meaningful in light and dark.

### Hard parts

1. **Approval density / rubber-stamping.** As parallelism climbs, the queue rewards speed, and every friction we add is friction an operator wants gone. The peek + per-row R8 + two-keystroke confirm + no-approve-all are our MVP answer, but the real open question is *risk-adaptive friction*: a 12-line diff on a docs repo shouldn't feel like a migration on prod. Uniform friction is honest but annoying; adaptive friction is humane but harder to trust. We ship uniform and instrument it.
2. **Ranking legibility vs. blast radius.** Oldest-first is ungameable and explainable but blind to how much a merge *matters*; a weighted score is the opposite. MVP chooses legibility and exposes the sort key. Revisit only with evidence that operators are working the wrong end of the queue.
3. **Staleness under a live projection.** In-flight runs mutate constantly and the Inbox is only a view of them, so optimistic inline approvals must reconcile against incoming events without the focused row shifting mid-click. We freeze the focused row's position and reconcile on blur — the correctness of R8 depends on this not lying to the operator's eyes.

## The Run detail — the one deep surface

Every other surface is a triage projection: the inbox ranks "what needs me," the board arranges runs in space, threads narrate. **The Run detail is the only place you go deep** — where you read the evidence and make the one decision the platform can't make for you: merge, or send it back. It is reached from any of them (inbox row, board card, thread message) and is the terminal destination of the two loud moments — **Needs Approval** and **Blocked**. It stays calm everywhere else.

### Route & container

**Primary: a right-side drawer backed by a real route `/run/:id`.** Opening a run from the inbox slides a drawer over the queue so you keep triage context — approve, hit Esc, you're back on the next row. The same `:id` route also renders **full-page** when navigated to directly (deep link from a notification, a shared URL, a browser refresh). Drawer and page render the *same* component tree; only the container differs, so there's no second implementation to keep honest.

*Alternative: full-page only — simpler focus and routing, but you lose the "stay in the queue" rhythm that makes triage fast, and every approval becomes a round-trip.*

The drawer subscribes through the **shared run store** (see the store section); closing it detaches the view, not the subscription, so a run someone else is watching keeps streaming.

### Anatomy

```
┌─ /run/482 ──────────────────────────────── [↗ open full] [Esc ✕] ┐
│ Add inbox triage home                        needs-approval       │  title: sans · chip: mono
│ agent sonnet-ship · acme/web · PR #482                            │  meta: mono
├───────────────────────────────────────────────────────────────────┤
│  ● Picked up          agent sonnet-ship · 2h ago            ▸      │  milestone timeline <ol>
│  ● Opened PR          #482 feat/inbox-triage                ▸      │
│  ● CI passed          12 checks · 3m14s                     ▸      │
│  ● Review round 1     changes requested · 2 notes           ▸      │
│  ● Review round 2     approved                              ▸      │
│  ● Evidence           before / after                              │
│       [before ▢]  →  [after ▢]                                     │
│  ● Ready for you      needs approval                              │
├───────────────────────────────────────────────────────────────────┤
│ ┏━ APPROVE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │  the one loud panel
│ ┃ ✓ CI green   ✓ review approved   ✓ no conflicts             ┃  │
│ ┃ Requested by @dana · built by sonnet-ship.                  ┃  │
│ ┃ Approving merges PR #482 into main and re-checks your       ┃  │
│ ┃ GitHub access.                                              ┃  │
│ ┃   [ Approve & merge ]      [ Request changes ]              ┃  │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
└───────────────────────────────────────────────────────────────────┘
```

### Header — `<RunHeader>`

- **Task title** (sans, human) — the thing a person asked for.
- **Meta line** (mono, machine): `agent sonnet-ship · acme/web · PR #482`. PR#, repo slug, branch, agent id are all machine tokens → monospace, and PR# links out to GitHub.
- **State chip** (`<StateChip>`, mono): the shipRun state as a single token — `queued` · `building` · `in-review` · `blocked` · `needs-approval` · `merging` · `merged` · `aborted`. Neutral by default; the chip carries text, never color alone. Only `blocked` and `needs-approval` get an accent, and even then the *panel* below is what goes loud — the chip just labels.

### Milestone timeline — `<MilestoneTimeline>`

The spine of the surface: **the ~5–15 human-meaningful events**, never the shell firehose. It's a reduction of the raw event stream into a stable milestone taxonomy — `picked_up · sandbox_ready · pr_opened · ci_result · review_round[n] · evidence_captured · blocked · ready · merged · aborted`. Each is one `<li>` in an `<ol>`: a sans human label, a mono detail, a real `<time>`.

Real copy:

| Label (sans) | Detail (mono) |
|---|---|
| Picked up | `agent sonnet-ship · 2h ago` |
| Opened PR | `#482 feat/inbox-triage` |
| CI passed | `12 checks · 3m14s` |
| CI failed | `2 checks red · lint, e2e` |
| Review round 1 | `changes requested · 2 notes` |
| Review round 2 | `approved` |
| Ready for you | `needs approval` |
| Blocked | `missing env STRIPE_KEY — needs your call` |

**The firehose is one disclosure deeper, opt-in, per milestone.** The `▸` on a milestone expands to reveal the raw shell/log slice that *produced* that milestone — you go from "CI passed" to the actual runner output only when you ask. There is no global always-on log stream on this surface; that's the point of milestone-not-firehose.

*Primary: reduced milestones + per-item expand. Alternative: full event log with a client-side filter toggle — more faithful, but it re-introduces the firehose as the default and drowns the signal.*

### Inline evidence — `<EvidencePair>`

Screenshots are addressed **by content hash**, so a before/after pair is `{ before: sha256, after: sha256, label }`. Rendered inline as a side-by-side `before → after` with the hash shown in mono on hover (provenance for the image itself). Lazy-loaded; a missing/expired blob degrades to a labeled placeholder, never a broken image.

*Primary: inline before/after in the timeline. Alternative: a lightbox opened on demand — lighter initial render, but hides the single most persuasive piece of the approval case.*

### Diff / PR view — `<DiffSummary>`

**Primary (MVP): a summary + link-out.** Files changed, `+/−` counts, per-file status (mono), and "Open PR #482 on GitHub." We don't own diff rendering on day one — large diffs, syntax highlighting, and expand/collapse are a rabbit hole, and GitHub already does it well.

*Alternative: inline client-rendered diff — better focus (no context-switch to GitHub), but it's a real cost sink for big diffs and a second thing to make accessible; defer past MVP.*

### Approval panel — `<ApprovalPanel>` (loud moment #1)

Only rendered loud when state is `needs-approval`. Three parts:

1. **Checks row** — the merge preconditions as mono status tokens: `✓ CI green` · `✓ review approved` · `✓ no conflicts`. Any red one disables Approve.
2. **Provenance line — provenance-forward, always spelled out before the button:**
   > Requested by **@dana** · built by agent `sonnet-ship`. **Approving merges PR #482 into main and re-checks your GitHub access.**

   This names *who asked*, *who built*, and *exactly what the click does* — including that the action revalidates *your* GitHub permission, so approval is your act, under your access, not the agent's.
3. **Actions**: `[ Approve & merge ]` (primary) and `[ Request changes ]`.

**Approve** transitions `needs-approval → merging`; the button locks (single-fire) and the panel shows a pending state until a `merged` (or a failure) event arrives. Because the merge and the GitHub-access recheck are async and can fail (conflict discovered at merge time, revoked token), the panel handles a bounced approval in place: "Couldn't merge — new conflicts in `app/inbox.tsx`. Sent back to `in-review`."

**Request changes** opens a composer. On submit it emits a `changes.requested` event carrying your note; the run transitions `needs-approval → in-review` and **your comment lands as additive feedback — a new review round on the same branch and history, not a restart.** Copy under the composer:
> Your note goes back to agent `sonnet-ship` as a new review round. The run keeps its branch and PR.

### Blocked panel — `<BlockedPanel>` (loud moment #2)

When state is `blocked`, the same panel slot goes loud with the blocker reason and two actions: `[ Continue ]` and `[ Abort ]`. Continue emits `block.resolved` (optionally with the input the agent asked for) and returns the run to `building`/`in-review`. **Abort is soft-destructive and gated behind a confirm** — it emits `run.aborted`, abandoning the run but *keeping* the branch and PR for forensics (no hard delete). Copy:
> Blocked: `missing env STRIPE_KEY`. Continue once it's set, or abort this run — the branch and PR are kept either way.

### Rendering model — a pure reduction

The entire surface is `reduce(events) → RunView`. Nothing here holds independent state; it is a deterministic fold over the run's event stream, delivered by **resumable SSE** (`Last-Event-ID` on reconnect), reconciled against an initial snapshot fetch.

```ts
type RunEvent =
  | { t:'run.created';  by; task; repo; ts }
  | { t:'run.picked_up'; agent; ts }
  | { t:'pr.opened';    prNumber; branch; url; ts }
  | { t:'ci.result';    state:'green'|'red'; checks; durMs; ts }
  | { t:'review.round'; n; verdict:'approved'|'changes'; notes; ts }
  | { t:'evidence';     before; after; label; ts }   // sha-addressed
  | { t:'run.blocked';  reason; ts }
  | { t:'run.ready';    ts }
  | { t:'changes.requested'; by; comment; ts }
  | { t:'run.merged';   sha; ts }
  | { t:'run.aborted';  by; ts }
  | { t:'shell.log';    slice; ts }                  // firehose, not a milestone

type RunView = {
  header: { title; agent; repo; prNumber; state }
  milestones: Milestone[]        // the reduced ~5–15
  evidence: EvidencePair[]
  checks: Check[]
  panel: 'none' | 'approval' | 'blocked'
  approval: { requestedBy; builtBy; prNumber }
}
```

The reducer is the single source of truth shared with every other view; the drawer, page, board card, and inbox row all read projections of the same fold. Unknown/future event types fold into the firehose bucket and are ignored by the milestone mapper — the reducer never throws on an event it doesn't recognize.

### Accessibility & type

- Timeline is a semantic `<ol>` of `<time>`-stamped items; new milestones announce via a **polite** live region — except `needs-approval` and `blocked`, which announce **assertive**.
- Drawer traps focus, restores focus to the originating row on close, Esc closes.
- State chip and check tokens carry text, not color alone; both accents meet contrast in **light and dark**.
- **Mono for machine** (PR#, SHA, hashes, branch, agent id, state, check names), **sans for human** (title, labels, review prose, the provenance sentence).

### Hard parts

1. **Milestone taxonomy is a product judgment, not a filter.** Deciding which raw events are "human-meaningful," collapsing N noisy events into one `review.round`, and keeping the mapping stable as new event types appear — while never crashing the reduction on an unknown event.
2. **Resumable SSE correctness.** Snapshot-plus-tail with no gap and no double-count, idempotent application (events redeliver), and out-of-order arrival. The fold must be deterministic and idempotent or the timeline flickers and lies.
3. **Stale approval.** The run can move while you're reading — a new commit lands, CI flips red, review round 3 arrives. Approve must **revalidate at submit** and refuse a stale merge ("This run changed since you opened it — round 3 arrived"), not fire against the version you *saw*.
4. **Approve is a real, async, failure-prone side effect.** Merge conflicts surface only at merge time; the GitHub-access recheck can fail. Optimistic vs. `merging` pending state, single-fire guarantees, and graceful bounce-back all live here — this is the one irreversible click in the product.
5. **Evidence by hash.** Fetch/cache content-addressed blobs, pair before/after, lazy-load, and degrade gracefully when a blob is missing or expired.
6. **Diff scope discipline.** Resisting the pull to render diffs inline for MVP; when it does come, big-diff performance and accessible keyboard navigation are their own project.
7. **Drawer/page/store consistency.** The same run open as a drawer here and full-page elsewhere must stay identical, and closing one container must not tear down a subscription another view depends on.
## The Board & Threads — the secondary views

The Inbox is home (see §2). The **Board** and **Threads** are two other *projections of the same run objects* — reached from the same view switcher, never re-fetched, never a separate app. Both read the one normalized run store fed by the one SSE stream (§3 owns the store); switching views loses nothing and re-derives everything. Which surface loads at `/` is a **per-user preference**, not a product opinion: `Settings → Home surface: Inbox (default) · Board · Threads`.

Routes: `/board`, `/threads`, `/threads/:channelId`. Run-detail (`/runs/:id`, §5) is the drill-in for all three.

---

### The Board — plan + demo, not the operational home

Say it plainly for the plan: the board is a **planning/backlog surface and a great screen-share**, not where an operator lives. Its value decays as run count grows (see Hard parts); the inbox is what scales. It earns its place by doing two jobs the inbox does poorly.

**Job A — Backlog grooming.** The **To Do** column is the *only* human-editable lane. Here you compose new tasks, reorder them, edit them, and then **Solve**. `boardOrder` is human-authored and persists server-side, distinct from the inbox's priority sort (§2).

**Job B — Live overview / demo.** Columns *are* run states, and a card walks itself across them as its run advances:

`To Do = QUEUED · In Progress = BUILDING · In Review = REVIEWING · Needs Approval = AWAITING_HUMAN · Done = MERGED` — plus **Blocked**.

```
 TO DO        IN PROGRESS   IN REVIEW     NEEDS APPROVAL     DONE
 (QUEUED)     (BUILDING)    (REVIEWING)   (AWAITING_HUMAN)   (MERGED)
 ┌─────────┐  ┌─────────┐   ┌─────────┐   ╔═════════╗        ┌────────┐
 │ + new…  │  │ #418 ▓▓ │   │ #402    │   ║ #397 ▲  ║        │ #388   │
 │ #421 ⠿  │  └─────────┘   └─────────┘   ║ Approve ║        └────────┘
 │ #420 ⠿  │                              ╚═════════╝
 └─────────┘                              (loud)
              ⚠ BLOCKED (loud) — #410 waiting on repo secret
```

Card anatomy — a shared `<RunSummary>` primitive, the same object the inbox row renders (mono-for-machine / sans-for-human):

```
┌──────────────────────────────┐
│ Add rate-limit to /login      │ ← title · sans (human)
│ web-api · feat/rl · a1c9f2    │ ← repo·branch·sha · mono (machine)
│ ◐ Fable   · BUILDING · 3m     │ ← agent + live state chip
└──────────────────────────────┘
```

**Rules, inherited from the platform — not re-invented here:**

- **Solve is the single money-authorization click** (§6 owns authorization). It lives on the To Do card (and a bulk **Solve selected**). A queued card is inert until Solved; Solving is what turns a plan into a running, billable agent.
- **Single-writer-per-lane.** Once Solved, the *run* owns its card's position across In Progress → Done. Human cross-column drags **snap back** with an `aria-live` toast: *"Runs move themselves. Fable owns this card from Build to Merge."* Only **To Do** is human-draggable, and only for `boardOrder`.
- **Live via the same SSE/event store.** A `run.state_changed` event moves the card in every mounted view at once; no board-specific socket.
- **Calm-by-default; loud only for the two human moments.** In Progress / In Review / Done are low-chroma. **Needs Approval** and **Blocked** get the accent treatment: count badge, icon + label (color is never the only signal — accessibility), and the inline **Approve** / **Unblock** affordance.

Components: `<BoardView>` › `<Column state>` › `<RunSummary>`, plus `<NewCardComposer>` (To Do only) and a keyboard-operable `<DragLayer>`. Composer placeholder: *"Describe a task — e.g. 'Add rate-limiting to the login endpoint'."* States to design: empty board, per-column empty, loading skeleton, drag-over, optimistic Solve (card greys → BUILDING on ack), snap-back.

- **Primary:** **Blocked is its own right-most loud column.** Mirrors the inbox's loud moment and keeps the mental model "this is the pile that needs a human."
- **Alternative:** Blocked as a horizontal swimlane cutting across stages — shows *where* each run stalled, but a heavier layout that competes with the state columns for attention.

- **Primary (MVP):** `dnd-kit` wired for **To Do reordering only**; every other lane is read-only/drag-to-snap-back. Small surface, teaches the right model.
- **Alternative:** free drag everywhere with universal snap-back — more code, and it invites the wrong mental model ("I push work through stages") that we then have to undo.

---

### Threads — the chat view

Slack-shaped, for two audiences: **chat-native teams** who want a channel as home, and **the conversation *on* a single run**. Every run has a thread; that's the seam.

- **@mention an agent to start a run.** Typing `@fable ship a dark-mode toggle for the settings page` in a channel opens a `<ConfirmSolve>` inline (still the money click — same authorization as the board's Solve), then spawns the shipRun and its thread.
- **Milestones stream into the thread** — milestone-not-firehose. The same milestone events the run-detail timeline shows (§5), rendered as calm mono `<MilestoneEvent>` rows (`▸ Build passed · 42 files · 2m`), collapsible, with "open run" to drill in. Not every log line.
- **Approve in-thread.** The AWAITING_HUMAN moment arrives as a loud, provenance-forward `<ApprovalCard>` — the *same component* the inbox and run-detail render (§6): leads with what changed (diff summary, files, which agent), then **Approve** / **Request changes**. Header copy: *"Needs your approval — Fable wants to merge #418 into `main`."*

Message taxonomy: human message (sans) · agent message (sans, tagged with agent identity + provenance) · milestone event (mono, calm, collapsible) · approval card (loud). Components: `<ThreadsView>` › `<ChannelList>` / `<Thread>` › `<Message>` | `<MilestoneEvent>` | `<ApprovalCard>`, with a `<Composer>` carrying `@`-mention autocomplete of available agents.

- **Primary (MVP):** ship **run-scoped threads only** — every run has a thread, and `@mention` starts a run. Reuses the store and approval card; almost no new server surface.
- **Alternative:** full free-form channels on day one — more genuinely Slack-like for chat-native teams, but adds channel membership, moderation, and unread-state surface we don't need to prove the model.

---

### One store, three projections

Inbox, Board, Threads (and run-detail) are selectors over one normalized store (§3 canonical):

```
Run { id, title, repo, branch, sha,
      state: QUEUED|BUILDING|REVIEWING|AWAITING_HUMAN|MERGED|BLOCKED,
      agent, boardOrder, threadId, provenance, updatedAt }
```

Board columns are derived selectors (`runsByState`); To Do = `filter(QUEUED).sort(boardOrder)`; Threads adds `Channel` + `Message` and joins on `threadId`. Because state lives in the store, not the view, switching surfaces is instant and consistent — and the snap-back / single-writer logic lives in the store reducer, so it can't drift between views.

---

### Hard parts

- **The board doesn't scale past a few dozen cards.** Columns overflow, it stops being scannable, and the DOM balloons. Mitigations: virtualize columns, collapse **Done** by default, and default the board filter to *my runs*. Design honestly around the fact that the board's value decays with N while the inbox's doesn't — which is *why* it isn't home.
- **Keeping three views consistent.** One event log is the only source of truth; optimistic updates must reconcile identically everywhere, so they mutate the store (not a view) and every projection re-derives. Watch two specific traps: `boardOrder` (human-authored, must persist) must not fight the inbox's priority sort, and a snap-back must announce via `aria-live` and revert store state, not just re-position a DOM node. Test that a single `run.state_changed` correctly updates every mounted projection at once.

## Notifications & cross-device — the real front door

The core loop is **delegate, walk away, get pulled back for the two moments.** If we've done our job, the operator is *not* staring at the app most of the day. So the real entry point isn't the Triage Home — it's a **push into a single decision** that arrives on whatever device is closest. This section owns everything outside the app that pulls the operator back in, and the one focused surface they land on.

**Thesis: the app is where you plan; notifications are where you act.** The board, the backlog, Threads, the Triage queue — those are *pull* surfaces you open when you choose to. Notifications are *push*: they exist to collapse "something needs a human" into "here is the one thing, here's why, approve or block." Every design choice below is in service of one number: **time-to-approve (TTA)**.

---

### What fires, what stays silent

The two-tier rule from the design principles (calm-by-default; loud only for **Needs Approval** & **Blocked**) is the notification policy, not just a UI mood. We split every run transition into `act` (a human decision is the only thing unblocking the run) and `fyi` (informational).

| Event | Tier | Real-time? | Copy (sans title / mono detail) |
|---|---|---|---|
| **Needs Approval** | `act` | **Yes, loud** | "Ready to merge — checkout-timeout fix" · `#1423 · review passed · +42 −6` |
| **Blocked** | `act` | **Yes, loud** | "Blocked — needs a secret" · `#1425 · missing STRIPE_KEY` |
| Finished / merged | `fyi` | No (digest) | "Merged ✓ checkout-timeout fix" · `#1423 → main` |
| Budget threshold | `fyi` | No (digest) | "Hit 80% of budget" · `#1424 · $1.60 / $2.00` |
| Stall / idle | `fyi` | No (digest) | "Idle 30m waiting on CI" · `#1424` |

**Silent — never a ping, ever:** sandbox spun up, build started, review iteration N, file edited, tests passing, agent thinking. These are the *firehose*. They mutate the run object and stream into Run-detail's timeline (see Run-detail section) but they never cross a channel boundary. The moment routine progress pings, the operator mutes us and the two moments that matter get lost in the noise. This is the single most important line in the section.

> **Primary:** exactly two `act` events (Needs Approval, Blocked) are loud/real-time; everything else is `fyi`/digest.
> **Alternative:** let Blocked be per-run configurable (loud vs digest) for operators running huge fan-outs — one-line tradeoff: more control, but a mis-set default means a run sits blocked for hours.

---

### Channels & per-user routing

Four channels, one routing matrix keyed by `(kind × channel × mode)`. Defaults are opinionated so a new user is correct on day one; the settings table (`/settings/notifications`) only exists for the minority who want to tune.

| Event | In-app inbox | Slack | Email | Mobile push |
|---|---|---|---|---|
| Needs Approval | ✓ | DM, real-time | real-time | ✓ (opt-in) |
| Blocked | ✓ | DM, real-time | digest | ✓ (opt-in) |
| Finished/merged | ✓ | channel | digest | — |
| Budget/Stall | ✓ | — | digest | — |

The **in-app inbox is not a separate store** — it's a selector over the shared run store (see Client data model section), `selectActionQueue(runs)`, which is the same query that renders the Triage Home. External notifications are emitted by a server-side notification service reading the *same* event log, so the in-app and out-of-app worlds can never disagree about what needs you.

> **Primary MVP channel set:** in-app + Slack + email. Mobile push is fast-follow via PWA web-push (no native app needed for v1).
> **Alternative:** lead with native mobile push first — tradeoff: best "walk away" ergonomics, but needs device-token infra and app-store presence before we can ship anything.

---

### The deep-link target is a **focused approval view**, not the board

Every `act` notification deep-links to one route:

```
/approve/:runId          → <FocusedApproval>   (mobile-first, minimal chrome)
```

It renders the *same* `<ApprovalPanel>` component as Run-detail (see Run-detail section), wrapped in stripped, thumb-reachable chrome — no nav rail, no board, no tabs. The operator tapped a push at a bus stop; they get the decision, not the application.

Never deep-link to the board or the Triage Home. Those are orientation surfaces; landing there adds a "now find the thing" step that directly inflates TTA.

> **Primary:** dedicated `/approve/:runId` focused view.
> **Alternative:** deep-link into full Run-detail scrolled to the approval panel — tradeoff: zero extra component to build, but heavier payload and more chrome to fight on a phone, measurably worse TTA.

**No sensitive data in the URL.** `/approve/:runId` carries only the run id; identity comes from the session, and authority is re-derived server-side (below). We never put tokens or approval capability in a query string.

---

### The notification is a pointer, never a capability

**Rule: never trust the notification action alone.** A Slack "Approve" button or an email link does *not* carry the authority to merge. This is the security spine of the whole feature.

- Slack messages get a single **navigational** button — `[ Review & approve → ]` — that opens `/approve/:runId`. There is **no inline "merge" in Slack.** A spoofed lookalike message can, at worst, send you to a link; it can never move code.
- On landing, `<FocusedApproval>` **re-fetches truth** and shows full provenance (provenance-forward approval): the diff, the review summary, checks, cost, agent identity, risk flags — freshly loaded, with a "re-checked just now" freshness stamp.
- Tapping **Approve & merge** fires the signed approve action; the server re-runs the **R8 merge-gate check** (branch unchanged since review, checks still green, no new commits, policy still satisfied) *at approve time*. A stale or spoofed nudge that arrives after the world moved resolves to **Already handled**, not a live button.

So the flow is always: *notification → focused view → re-derived state → signed, R8-re-checked approve.* The ping is bait to get you to the authenticated decision; it is never the decision.

> **Primary:** session-bound signed approve + server R8 re-check on every approve.
> **Alternative:** add WebAuthn/passkey **step-up** for runs flagged high-risk (prod, secrets, large diff) — tradeoff: more assurance, one extra tap; keep it off the low-risk common path.

---

### The mobile / focused-approval layout

Single column, thumb zone at the bottom. Machine facts in mono, human sentences in sans (see Design system section for the type + theme tokens; both themes required).

```
┌─────────────────────────────┐
│ ← Inbox            🟢 Ready   │  status pill (icon+label, not color alone)
│                             │
│ Checkout-timeout fix        │  ← run title            (sans)
│ shipRun #1423 · agent:swe-1 │  ← id + agent identity  (mono)
│ Re-checked just now ✓       │  ← R8 freshness stamp
│─────────────────────────────│
│ WHAT CHANGED                │
│  +42 −6 · 3 files           │  (mono)
│  ▸ src/checkout/timeout.ts  │  collapsed diff, tap to expand (mono)
│ WHY                         │
│  "Retry on 504, cap at 3."  │  task + review summary  (sans)
│ CHECKS      lint ✓ test ✓ ci✓│  (mono, icon+label)
│ COST        $0.38 / $2.00   │  (mono)
│─────────────────────────────│
│ [ Approve & merge ]  ← primary, guarded
│ [ Request changes ] [ Block ]
│ [ Open full run → ]         │
└─────────────────────────────┘
```

Approve opens a confirm sheet that echoes the live R8 result (`3 checks green · no new commits since review`) before the signed call — so the loud, irreversible action always shows its evidence one more time.

**States for `<FocusedApproval>`:**

| State | UI |
|---|---|
| `re-checking` | skeleton + "Re-checking…" freshness spinner |
| `ready` | R8 green → Approve enabled |
| `guarded` | R8 flagged (e.g. new commits since review) → Approve **disabled** with the reason inline: "3 new commits landed — re-review needed" |
| `already-handled` | someone/something resolved it → "Already merged by @dana" + "Open run", no approve button |
| `approving` | in-flight, buttons locked |
| `merged` | success → "Merged → main ✓", link to run |
| `expired` | session lapsed → re-auth, then re-derive (never approve blind) |

Accessible: fully keyboard-navigable, every status conveyed by icon **and** label (never color alone), screen-reader-announced state changes.

---

### Digest vs real-time, and coalescing

- **Real-time:** only the two `act` moments.
- **Digest:** all `fyi`. MVP default = **one daily rollup** email + a Slack channel summary, with quiet-hours respected. Subject line does the triage: *"Your shipRuns: 2 need approval, 1 blocked, 4 merged."*
- **Coalescing (critical):** a notification is a **living object keyed by `runId`**, not an append-only stream. A run that goes `blocked → unblocked → needs-approval` must **update in place** — edit the Slack message, replace the push — not fire three pings. This falls straight out of "all surfaces are projections of the same run object": one run, one live notification.

```ts
type NotifKind = 'needs_approval' | 'blocked' | 'finished' | 'budget' | 'stall'
type Channel   = 'inapp' | 'slack' | 'email' | 'push'

type Notification = {
  id: string; runId: string; kind: NotifKind
  level: 'act' | 'fyi'
  title: string                 // sans human copy
  createdAt: string; readAt?: string; actedAt?: string; dismissedAt?: string
  supersedes?: string           // coalescing: replaces an earlier notif for the same run
}
type RoutingPref = Record<NotifKind, { channels: Channel[]; mode: 'realtime' | 'digest' }>
```

> **Primary:** real-time for the two moments + one daily `fyi` digest.
> **Alternative:** per-run "watch" subscriptions for `fyi` — tradeoff: precise, but requires curation and makes a bad default; offer as opt-in on top, not instead of.

---

### The core metric: time-to-approve

Instrument the funnel per notification: `notified_at → opened_at → approved_at`. Surface **median TTA** on an internal dashboard; it's the north star for this whole surface. Every decision above is a lever on it — deep-link straight to the focused panel, provenance pre-loaded, sticky thumb-reachable action, no board detour. Watch the **notify→open rate** as the counter-metric: if it falls, we're over-notifying and training mutes.

---

### Hard parts

- **Notification trust / spoofing.** Operators are conditioned to tap. A phishing email that mimics our "Ready to merge" is the real threat. Defense is architectural, not cosmetic: **notifications carry no authority** (covered above), so the worst a spoof achieves is sending you to a link — and the focused view always re-derives truth from the session and shows a freshness stamp, so a stale/forged nudge resolves to *Already handled*, never a live approve. In-app copy reinforces it: "Approvals always happen in-app — links only take you there." (Email DKIM/branding is back-end's to own.)

- **Over-notifying.** The fastest way to get muted, and once muted the two moments are lost. Mitigations, all client-visible: milestone-not-firehose (two loud events, everything else digested); **coalesce** per run; auto-suppress a ping if the operator is already viewing that run; per-run **mute** and **snooze**; quiet hours. If notify→open rate dips, we've crossed the line — treat it as a regression, not a preference.

- **Cross-device consistency.** The same run can be approved from a laptop while a phone push is mid-flight. The living-notification model + server-side R8 re-check make this safe (the phone lands on *Already handled*), but the client must handle the race gracefully rather than showing a dead Approve button — hence the explicit `already-handled` state.

## 6. The component & client-state system, design language, and build order

This section owns the *machinery* under every surface: the shared store, the atomic components, the design tokens, the stack, and the order we build in. The surfaces themselves — inbox ranking/triage UX, run-detail layout, threads, the approval flow's policy — are specified in their own sections. Here the through-line is one claim: **every surface is a pure reduction of one run/event log.** Get that right and inbox, board, thread, and run-detail are four `select*()` calls, not four apps.

---

### 6.1 Client data model — one log, one reducer, four projections

The back-end already emits a durable, ordered event log per run. The front-end never invents run truth; it *derives* it. The whole client is:

```
snapshot ─┐
          ├─▶ @ship/reducer ──▶ Store ──▶ selectInbox / selectBoard / selectRunDetail / selectThread
SSE tail ─┘                      (Map<runId, RunState>)
```

**The reducer is a standalone package (`@ship/reducer`), pure and framework-free.** No React, no `fetch`, no clock. `reduce(store, event) → store`. This is the single most valuable asset in the front-end, so it gets **golden tests**: fixture event logs (`fixtures/*.jsonl`) → asserted projection snapshots. A run's entire life — queued through merged, and every ugly path (blocked, retried, force-pushed, superseded) — is a checked-in log we can replay in CI. When a projection looks wrong in prod, we capture the log and it becomes a golden test.

```ts
// @ship/reducer — pure, ordered, deterministic
type Seq = number;
interface ShipEvent { seq: Seq; runId: string; type: EventType; at: string; payload: unknown }

interface RunState {
  id: string; title: string;                 // title = human (sans)
  state: RunPhase;                            // QUEUED|BUILDING|IN_REVIEW|NEEDS_APPROVAL|BLOCKED|MERGING|MERGED|FAILED
  severity: 'good' | 'warn' | 'critical' | 'active';
  pr?: number; sha?: string; branch?: string; // machine (mono)
  agent: AgentRef; checks: CheckSummary;
  blockedReason?: string; approval?: ApprovalCtx;
  updatedAt: string; lastSeq: Seq;            // lastSeq drives ordering + gap detection
}
type Store = { runs: Map<string, RunState>; headSeq: Seq };
```

**Selectors are the only thing surfaces call.** Each is a pure function of `Store`; none holds state.

```ts
selectInbox(store, {filters, ranker}): InboxRow[]      // filtered + ranked projection — the home
selectBoard(store): Record<RunPhase, RunCard[]>        // group-by-state projection — a VIEW
selectRunDetail(store, id): RunDetail
selectThread(store, id): ThreadEvent[]
```

The inbox is **not** a special store — it is `selectBoard`'s data run through a filter + rank instead of a group-by. Same objects, different projection. That is the payoff of the core decision: demoting the board to a view costs us zero extra state.

**Live = snapshot + resumable SSE.** On mount, `GET /api/snapshot` returns the materialized projection at `headSeq = N` (so we never replay all history), then we open the tail:

```
GET /api/stream?since=N
event: run
id: 4213                        ← seq as SSE event id
data: {...ShipEvent}
```

On any drop the browser reconnects automatically with `Last-Event-ID: 4213`; the server replays from `4214`. The client asserts **contiguity**: if an arriving `seq !== expected`, we have a gap — drop the stream, re-`snapshot`, reopen. This is the one place we distrust the wire, and it's cheap. (The exact event contract lives in the back-end-integration section; the front-end only depends on *ordered + resumable + gap-detectable*.)

**Optimistic writes reconcile on echo.** The two write actions from this surface (approve/merge, block/request-changes) tag a `clientTxnId`, patch the local `RunState` immediately, and wait for the authoritative event carrying the same `clientTxnId` to replace the optimistic patch. On reject we roll back and surface it — never silently. This keeps Approve feeling instant without ever *lying* about a merge that didn't land.

```ts
dispatchIntent({ type: 'approve', runId, clientTxnId }); // optimistic patch now
// server emits authoritative event w/ clientTxnId → swap in; on reject → rollback + toast
```

**Presence is ephemeral and off the log.** "Which humans are looking at this run" and stream-liveness come from a **separate channel** (`/api/presence`), never persisted, never fed to the reducer. Presence may lie or vanish; run truth may not. This separation is load-bearing for the presence rings below.

- **Store binding — primary:** a thin `useSyncExternalStore` adapter over the reducer (the reducer owns state; React just subscribes). **Alt:** Zustand — friendlier ergonomics, but it tempts contributors to stash surface-local state in the store, which erodes the "one log" invariant.

---

### 6.2 Component system — the run-object is the atom

Every surface renders the same primitive at different densities. Build it once.

**`<RunObject variant="row|card|header">`** — the atomic unit. Inbox row, board card, and run-detail header are three variants of one component reading one `RunState`. Consistency is structural, not disciplined.

**State chip + severity system.** `<StateChip>` renders a mono label + a dot: `QUEUED · BUILDING · IN REVIEW · NEEDS APPROVAL · BLOCKED · MERGING · MERGED · FAILED`. Its color comes from **`severity`, a field kept deliberately separate from the accent**:

| severity | meaning | color role |
|---|---|---|
| `active` | agent is working (building/reviewing/merging) | **accent (teal)** |
| `good` | passing / merged | semantic green |
| `warn` | needs attention — **`NEEDS APPROVAL`** | semantic amber |
| `critical` | **`BLOCKED`** / failed | semantic red |

Because "agent working" is the accent and not a semantic status, a calm screen full of teal reads as *healthy motion*, and green/amber/red are reserved for things that are actually good/uncertain/wrong. The two loud human moments — **Needs Approval** and **Blocked** — are the only states that also get elevated affordances (a claim/action zone, sort-to-top, notification eligibility). Everything else is quiet by construction.

**Presence rings.** An avatar ring around the agent/human indicator. The **agent-working ring is run-derived** (`severity === 'active'`), pulsing teal — it comes from the *log*, so it can't drift from run truth. Human-viewing rings come from the *presence channel* and are neutral-slate; they may flicker without ever implying a state change. Two sources, visually distinct, never confused.

**`<ApprovalPanel>` — provenance-forward.** The panel leads with *what am I signing off on*, in machine type: PR #, `sha` (short + copyable), branch, checks summary, diff stat, and the agent that produced it. Identity/attestation ("signed by", "approved by you") renders in the **violet identity color** — the one place provenance gets its own hue. Copy is blunt about consequence:

> **Your approval merges this.** &nbsp; PR `#482` · `a1f9c3e` · 3 files · checks `4/4`
> `[ Approve & merge ]`  ·  `Request changes`  ·  `Block`

Blocked state gets a matching banner: **"Blocked — needs a human."** with the agent's stop reason in human sans and the failing step in mono.

**Type as a signal, not decoration.** **Mono for machine** (states, `PR#`, `sha`, branch, timestamps, durations, run IDs); **sans for human** (task titles, review prose, agent explanations). The reader learns instantly which tokens are copy-pasteable machine facts and which are language. This is a rule enforced at the component boundary — `<Machine>` and default text — not left to authors.

---

### 6.3 Design language — a calm supervision console

The reference point is Linear-grade restraint: an operator watching many parallel runs should feel a quiet cockpit, not a dashboard shouting for attention.

- **Cool-slate neutrals, chosen not defaulted.** A hand-picked blue-tinted slate ramp (`slate-50…slate-950`), not Tailwind's default gray. The tint reads as "instrument," and it makes teal sit calmly rather than buzzing.
- **One accent = agent working (teal).** The only accent in the product. If teal is on screen, machines are moving. We do not use it for buttons, links, or focus generically — that would dilute the single meaning.
- **Semantic green / amber / red** for run states only (good / needs-you / wrong).
- **Violet reserved for identity & signed provenance** — approvals, attestations, "you." Never used decoratively.
- **Both themes via tokens.** Semantic roles are CSS variables; components never name a raw color. Light/dark is a token swap, and the semantic ramps are tuned *per theme* to hold **AA contrast** (amber especially is a two-value token, not one color dimmed).

```css
:root {           /* light */         :root[data-theme='dark'] {
  --bg:  #f7f8fa;                        --bg:  #0d1014;
  --surface: #ffffff;                    --surface: #14181d;
  --border: #e3e7ec;                     --border: #232a31;
  --text: #1b2027;  --muted:#5b6672;     --text:#e6ebf0; --muted:#8a97a5;
  --accent:#0d9488;      /* teal      */ --accent:#2dd4bf;
  --good:#15803d; --warn:#b45309;        --good:#22c55e; --warn:#f59e0b;
  --critical:#b91c1c;                    --critical:#f87171;
  --identity:#7c3aed;    /* violet    */ --identity:#a78bfa;
}
```

- **Motion for exactly one moment: a run changing state.** When a row/card transitions (e.g. `IN REVIEW → NEEDS APPROVAL`), it plays a single signature move — a brief highlight sweep + chip crossfade, then settles. Nothing else animates: no spinners-as-decoration, no entrance choreography. The scarcity is what makes "something just changed" legible across a long list.
- **Accessibility is part of the spec, not a pass:** full keyboard triage (email-client model — `j/k` move, `Enter` open, `a` approve, `b` block, `x` archive), visible focus rings on every interactive element (a slate ring, distinct from teal-as-status), `prefers-reduced-motion` collapses the signature transition to a pure crossfade (keeps the *signal*, drops the movement), and AA contrast verified in both themes for text *and* the semantic chip colors.

---

### 6.4 Stack

- **Next.js App Router.** Routes map 1:1 to surfaces: `/` (inbox home), `/runs/[id]` (run detail), `/board` (board view toggle), `/runs/[id]/thread` (thread). Server components render the shell and fetch the initial `snapshot`; a single client boundary owns the live store and selectors below it.
- **Tailwind + a headless component lib — primary: Radix primitives** styled entirely through the token variables (accessible behavior for free, zero baked-in visuals). **Alt: React Aria Components** — stronger a11y guarantees, steeper authoring cost; reach for it only if keyboard/ARIA needs outgrow Radix.
- **`@ship/reducer` as a workspace package** — framework-agnostic TypeScript, no React import. Consumed by web today; reusable verbatim by a CLI or mobile client later. This is the boundary that lets "one log, four projections" survive contact with new surfaces.

---

### 6.5 Build order — slotted against the platform roadmap

The Phase-1 money loop is *a human approving a merge*. The front-end for that is deliberately **conventional** — a list and a detail pane — not the board, not chat.

| Phase | Ship | Why here |
|---|---|---|
| **MVP** | **Inbox + Run-detail + inline Approve** (no board, no threads). Store + `@ship/reducer` + snapshot/SSE + `selectInbox`/`selectRunDetail`; `RunObject`, `StateChip`, `ApprovalPanel`; tokens + both themes. | This *is* the Phase-1 money-loop surface. Proves the store and the two loud moments end-to-end on the smallest possible UI. |
| **2** | **Board view** (toggle). | Almost free — `selectBoard` over the same store. The card walking columns is the demo/planning surface, earned only after the money loop works. |
| **3** | **Threads** (chat) view. | `selectThread` + composer. Same objects; adds a conversational projection. |
| **4** | **Notifications + mobile.** | Push only for `NEEDS APPROVAL` and `BLOCKED` (the two loud moments); mobile is triage-first — inbox + approve, board/threads read-only. |

Each phase adds a *selector and a surface*, never a second source of truth.

---

### 6.6 Hard parts (call them now)

1. **The snapshot↔tail seam.** Getting exactly-once projection across "snapshot at N, then stream from N+1," including the gap-detect → re-snapshot path, under real reconnects. This is where subtle duplicate/missing-event bugs hide; the golden-test harness is the mitigation.
2. **Optimistic approval reconciliation.** Approve must feel instant yet *never* display a merge that didn't happen or allow a double-approve. Correct `clientTxnId` handling on reject/rollback is fiddly and safety-critical.
3. **The inbox ranker.** Turning many active runs into "what needs me now" without a firehose — a ranking function that surfaces the two loud moments and stays calm otherwise. (Policy owned by the inbox section; this store just has to make it a pure `selectInbox` argument so it's tunable and testable.)
4. **Keeping projections honest as features grow.** The pressure to stash per-surface state ("just cache the board order here") is constant; the `@ship/reducer` boundary and a lint rule against store writes outside intents are the guardrails.
5. **Presence liveness vs. run truth.** The agent-working ring must not keep pulsing when the stream has silently stalled — reconcile ring state against `lastSeq` freshness, and let a stale tail *look* stale rather than *look* busy.
6. **Semantic color in two themes.** Holding AA contrast for amber/green/red chips against slate surfaces in both light and dark, without the accent teal and the semantic set ever collapsing into each other for low-vision or colorblind operators (dot + mono label carry meaning even if hue fails).

