// ─────────────────────────────────────────────────────────────────────────────
// Projections. Every surface is a pure selector over one store. Zero surface-
// local run state. (FRONTEND_PLAN §0: selectInbox / selectBoard / selectRunDetail)
// ─────────────────────────────────────────────────────────────────────────────
import type { StoreState, RunState, RunStateName, Member } from "./types";
import { isInFlight, isBlocked, RUN_LABEL } from "./labels";

export interface InboxFilters {
  mineOnly?: boolean; // requested by or assigned to current user
  repoId?: string | null; // null = all repos
}

/** A run is visible only if its repo is connected. */
export function visibleRuns(state: StoreState, filters: InboxFilters = {}): RunState[] {
  const all = Object.values(state.runs);
  return all.filter((r) => {
    const repo = state.repos[r.repoId];
    if (!repo || !repo.connected) return false;
    if (filters.repoId && r.repoId !== filters.repoId) return false;
    if (filters.mineOnly) {
      if (r.requestedById !== state.currentUserId) return false;
    }
    return true;
  });
}

export interface InboxProjection {
  needsYou: {
    readyToApprove: RunState[];
    blocked: RunState[];
  };
  inFlight: RunState[];
  recentlyShipped: RunState[];
  counts: { needsYou: number; inFlight: number; shipped: number };
}

/** Oldest-first: the longest-waiting approval is the most urgent. */
function byOldest(a: RunState, b: RunState): number {
  return b.ageMinutes - a.ageMinutes;
}
function byNewest(a: RunState, b: RunState): number {
  return a.ageMinutes - b.ageMinutes;
}

export function selectInbox(state: StoreState, filters: InboxFilters = {}): InboxProjection {
  const runs = visibleRuns(state, filters);
  const readyToApprove = runs.filter((r) => r.runState === "AWAITING_HUMAN").sort(byOldest);
  const blocked = runs.filter(isBlocked).sort(byOldest);
  const inFlight = runs.filter(isInFlight).sort(byNewest);
  const recentlyShipped = runs
    .filter((r) => r.runState === "DONE" || r.runState === "CANCELLED")
    .sort(byNewest);

  return {
    needsYou: { readyToApprove, blocked },
    inFlight,
    recentlyShipped,
    counts: {
      needsYou: readyToApprove.length + blocked.length,
      inFlight: inFlight.length,
      shipped: recentlyShipped.length,
    },
  };
}

/** The rail badge + notification count. */
export function needsYouCount(state: StoreState): number {
  return selectInbox(state).counts.needsYou;
}

export interface BoardColumn {
  key: string;
  label: string;
  states: RunStateName[];
  runs: RunState[];
}

const BOARD_DEF: { key: string; label: string; states: RunStateName[] }[] = [
  { key: "todo", label: "To do", states: ["QUEUED"] },
  { key: "building", label: "Building", states: ["BUILDING"] },
  { key: "review", label: "In review", states: ["REVIEWING", "REVIEW_FEEDBACK"] },
  { key: "approve", label: "Needs approval", states: ["AWAITING_HUMAN"] },
  { key: "blocked", label: "Blocked", states: ["ESCALATED", "FAILED"] },
  { key: "done", label: "Merged", states: ["MERGING", "DONE"] },
];

export function selectBoard(state: StoreState, filters: InboxFilters = {}): BoardColumn[] {
  const runs = visibleRuns(state, filters);
  return BOARD_DEF.map((col) => ({
    ...col,
    runs: runs.filter((r) => col.states.includes(r.runState)).sort(byNewest),
  }));
}

export interface RunDetailProjection {
  run: RunState;
  agent?: Member;
  requester?: Member;
  /** Optimistic client-R8 pre-check — never the gate; server re-checks at approve. */
  approval: {
    ciGreen: boolean;
    reviewApproved: boolean;
    noConflicts: boolean;
    canApprove: boolean;
  };
}

export function selectRunDetail(state: StoreState, runId: string): RunDetailProjection | null {
  const run = state.runs[runId];
  if (!run) return null;
  const ciGreen = run.checks.state === "success";
  const reviewApproved = run.review.state === "approved";
  const noConflicts = true; // fixture has no merge conflicts
  return {
    run,
    agent: state.members[run.agentId],
    requester: state.members[run.requestedById],
    approval: {
      ciGreen,
      reviewApproved,
      noConflicts,
      canApprove: run.runState === "AWAITING_HUMAN" && ciGreen && reviewApproved && noConflicts,
    },
  };
}

export function memberById(state: StoreState, id: string): Member | undefined {
  return state.members[id];
}

/** Friendly label for a run's current state. */
export function labelFor(run: RunState): string {
  return RUN_LABEL[run.runState];
}
