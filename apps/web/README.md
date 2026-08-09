# Acme console — Next.js front-end

The supervision UI for parallel AI coding-agent runs: **triage → review → approve → merge**.
Inbox-first, powered entirely by a fixture (`data/simulation.json`) so every intended flow —
connect a repo → the inbox populates → start a task → watch the agent work → approve & merge —
runs with no backend.

Matches the pinned visual design: warm off-white ground, teal-green brand (machine identity,
agent handles, links), amber **Approve & merge** CTA, blue in-flight, red blocked, green merged.
Light + dark themes.

## Run it

```bash
cd apps/web
npm install
npm run dev        # http://localhost:3000  → redirects to /inbox
```

```bash
npm run build      # production build (all 9 routes)
npm run typecheck  # tsc --noEmit
```

## Responsive

Fully responsive down to phones (≤768px). The rail collapses into an off-canvas drawer opened by a topbar hamburger; the view switcher goes icon-only; Threads' two-pane collapses to a horizontal channel bar over the message pane; inbox rows drop the desktop extras to keep title + state legible; the run/agent drawers go full-bleed; and forms, the onboarding stepper (dots-only), and the command palette all reflow to a single column. All mobile rules live in media queries, so desktop is untouched. (Text inputs use a 16px font on mobile to avoid iOS zoom-on-focus.)

## Architecture (mirrors FRONTEND_PLAN §0 / SYSTEM_PLAN §2)

The store, reducer, and selectors are **framework-free** — the `@ship/reducer` equivalent. In
production they are fed by a resumable SSE tail (snapshot at N, stream from N+1); here the same
interface is fed by a local `SimEngine`. Swapping the transport touches only `lib/sim.ts`.

```
lib/
  types.ts        Canonical run_state, Severity, RunState, ShipEvent — pure data, no React.
  labels.ts       RUN_LABEL / CHIP_LABEL / severityFor — presentation over run_state.
  reducer.ts      Pure fold: (state, event) -> state. State is DERIVED; no run.state_changed.
  selectors.ts    Projections: selectInbox (banded), selectBoard, selectRunDetail.
  store.ts        Normalized store: subscribe / getSnapshot / dispatch. Builds state from fixture.
  sim.ts          SimEngine: replays fixture `pending` timelines + action `scripts` as events.
  react.tsx       useSyncExternalStore binding + action surface + toasts.

components/
  Shell.tsx       Rail (org switcher, nav+badge, user + theme toggle) · centered view switcher
                  · search/gear · drawer host · toasts. Provides UICtx (open run / new task).
  RunObject.tsx   The one atom: <Avatar> <StateChip> <RunRow> (inbox) <BoardCard>. State is a prop.
  RunDetail.tsx   Drawer AND full page: breadcrumb · milestone timeline · evidence (before→after)
                  · ApprovalPanel (cream) · BlockedPanel · request-changes composer.
  Inbox.tsx       Bands A) Needs you  B) In flight  C) Recently shipped · filter bar · empty states.
  Board.tsx       Columns = run states (planning/demo surface).
  Members.tsx · Connections.tsx · Threads.tsx · NewTask.tsx · icons.tsx

app/
  layout.tsx      Root: theme boot script + <StoreProvider> + <Shell>.
  page.tsx        → /inbox
  inbox · board · threads · members · connections   the surfaces
  runs/[id]/page.tsx   route-backed full-page run detail
```

### Flows to try

0. **Sign in & onboard** — first load lands on **/login** (Continue with GitHub / Nostr key / magic link — all simulated, no credentials collected). Sign-in routes to the **/onboarding** wizard (name workspace → connect repos → configure agent → done), which applies your choices and drops you in the inbox. The session (authed/onboarded) persists in `localStorage`; **Log out** / **Restart onboarding** live in the rail's user menu. The auth gate lives in `Shell.tsx`.
1. **Connect a repo** — `web-app` / `payments` start disconnected. Go to **Connections → Connect**;
   `web-app` populates the inbox with its open runs, `payments` shows "nothing there yet".
2. **Start a task** — **New task** → pick a repo, describe it → the run appears and the agent works
   it live (Queued → Building → PR → CI → review → **Needs approval**).
3. **Approve & merge** — open a *Needs approval* run → the cream approval panel → **Approve & merge**
   → Merging → Merged, and it leaves your queue.
4. **Request changes** — sends the run back to the agent, which addresses and returns to approval.
5. **Unblock** — the *Blocked* run offers **Continue** (with an optional hint) or **Abort**.

## Prototype simplifications (production swaps)

- **Transport:** local `SimEngine` on timers stands in for resumable SSE + the golden-fixture harness.
- **Styling:** hand-authored token CSS (for exact design control) rather than Tailwind + Radix.
- **R8 / approval:** the approval panel's checks are the *optimistic client pre-check*; the real merge
  gate is server-side R8 re-checked at approve-time. No server here.
- **Evidence** thumbnails are sketched; real runs attach screenshots from the artifact bucket.
- **Auth** is simulated (no real OAuth/magic-link). Only the session flag persists in `localStorage`; the fixture store itself resets on reload, so onboarding customizations (workspace rename, extra repos) apply for the session but revert on refresh. To replay login/onboarding, use **Log out** / **Restart onboarding** in the rail, or clear the `acme-session` localStorage key.
