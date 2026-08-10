// ─────────────────────────────────────────────────────────────────────────────
// Projections. Every surface is a pure selector over one store. Zero surface-
// local run state. (FRONTEND_PLAN §0: selectInbox / selectBoard / selectRunDetail)
// ─────────────────────────────────────────────────────────────────────────────
import type { StoreState, RunState, RunStateName, Member, RunPhase } from "./types";
import { isInFlight, isBlocked, RUN_LABEL } from "./labels";

/** Map the coarse run state (+ loop progress) to the diagram's named phase. */
export function selectRunPhase(run: RunState): RunPhase {
  const s = run.runState;
  if (s === "DONE" || s === "MERGING") return "MERGED";
  if (s === "ESCALATED" || s === "FAILED" || s === "CANCELLED") return "BLOCKED";
  if (s === "AWAITING_HUMAN") return "HUMAN";
  if (run.verification.status === "RUNNING") return "TESTING";
  if (s === "REVIEWING") return "REVIEW";
  if (s === "QUEUED") return "FEATURE";
  if (!run.prNumber && run.events.length <= 2) return "PLANNING";
  return "BUILD";
}

export interface LoopStatus {
  testing: { attempts: number; status: RunState["verification"]["status"] };
  review: { rounds: number; maxRounds: number; current: number; state: RunState["review"]["state"]; lastScore?: number };
}
export function selectLoops(run: RunState): LoopStatus {
  const lastRound = run.review.rounds[run.review.rounds.length - 1];
  return {
    testing: { attempts: run.verification.attempts.length, status: run.verification.status },
    review: {
      rounds: run.review.rounds.length,
      maxRounds: run.review.maxRounds,
      current: run.review.currentRound,
      state: run.review.state,
      lastScore: lastRound?.score,
    },
  };
}

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
  { key: "review", label: "In review", states: ["REVIEWING"] },
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
  task?: import("./types").Task;
  phase: RunPhase;
  loops: LoopStatus;
  /**
   * Optimistic client-R8 pre-check — NEVER the gate; the server re-runs this
   * (fresh SHA, checks, review verdict, mergeability, authorization) at approve.
   */
  approval: {
    ciGreen: boolean;
    reviewApproved: boolean;
    blockingComments: number;
    noConflicts: boolean; // == mergeable
    mergeable: boolean;
    verificationOk: boolean;
    machineReady: boolean;
    canApprove: boolean;
  };
}

export function selectRunDetail(state: StoreState, runId: string): RunDetailProjection | null {
  const run = state.runs[runId];
  if (!run) return null;
  const ciGreen = run.checks.state === "success";
  const reviewApproved = run.review.state === "approved";
  const blockingComments = reviewApproved ? 0 : run.review.rounds[run.review.rounds.length - 1]?.blockingComments ?? 0;
  const mergeable = run.mergeability === "MERGEABLE";
  const verificationOk = run.verification.status === "NOT_REQUIRED" || run.verification.status === "PASSED";
  const machineReady = ciGreen && reviewApproved && blockingComments === 0 && mergeable && verificationOk;
  return {
    run,
    agent: state.members[run.agentId],
    requester: state.members[run.requestedById],
    task: state.tasks[run.taskId],
    phase: selectRunPhase(run),
    loops: selectLoops(run),
    approval: {
      ciGreen,
      reviewApproved,
      blockingComments,
      noConflicts: mergeable,
      mergeable,
      verificationOk,
      machineReady,
      canApprove: run.runState === "AWAITING_HUMAN" && machineReady,
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
