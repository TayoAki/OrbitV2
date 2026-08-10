// ─────────────────────────────────────────────────────────────────────────────
// The fold. Pure: (state, event) -> state. No timers, no React. Events are TYPED
// domain events (see types.ShipEventType); the reducer folds them into the coarse
// run_state and maintains the per-run event log, review rounds, and verification.
// ─────────────────────────────────────────────────────────────────────────────
import type {
  ShipEvent,
  StoreState,
  RunState,
  RunStateName,
  RunEvent,
  VerificationAttempt,
} from "./types";

function pseudoSha(id: string, seq: number): string {
  let h = 2166136261;
  const s = `${id}:${seq}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(7, "0").slice(0, 7);
}

/** Fallback state when a real backend event carries no explicit toState. */
function impliedState(type: string): RunStateName | undefined {
  switch (type) {
    case "agent.started":
    case "agent.progress":
    case "revision.started":
    case "revision.pushed":
    case "run.resumed":
      return "BUILDING";
    case "review.started":
    case "review.changes_requested":
    case "review.approved":
      return "REVIEWING";
    case "human.approval_requested":
      return "AWAITING_HUMAN";
    case "merge.started":
      return "MERGING";
    case "merge.completed":
      return "DONE";
    case "run.escalated":
      return "ESCALATED";
    case "run.cancelled":
      return "CANCELLED";
    default:
      return undefined;
  }
}

function markLastAttempt(
  attempts: VerificationAttempt[],
  status: "PASSED" | "FAILED",
  patch: Partial<VerificationAttempt> = {},
): VerificationAttempt[] {
  if (!attempts.length) return attempts;
  return attempts.map((a, i) => (i === attempts.length - 1 ? { ...a, status, completedAt: new Date().toISOString(), ...patch } : a));
}

/** Fold a run-scoped typed event into its run. */
function foldRun(state: StoreState, ev: ShipEvent): StoreState {
  const run = state.runs[ev.runId];
  if (!run) return state;
  const p = ev.payload;
  let nextPr = state.nextPr;

  const next: RunState = {
    ...run,
    checks: { ...run.checks },
    review: { ...run.review, rounds: run.review.rounds.slice() },
    verification: { ...run.verification, attempts: run.verification.attempts.slice() },
    events: run.events.slice(),
  };

  // ── PR ──
  if (ev.type === "pr.created" && !next.prNumber) {
    next.prNumber = p.prNumber ?? nextPr;
    if (p.prNumber === undefined) nextPr = nextPr + 1;
    next.headSha = p.headSha ?? pseudoSha(next.id, ev.seq);
  }

  // ── CI ──
  if (ev.type === "ci.started") next.checks = { ...next.checks, state: "pending" };
  else if (ev.type === "ci.passed") next.checks = { ...next.checks, state: "success" };
  else if (ev.type === "ci.failed") next.checks = { ...next.checks, state: "failure" };
  else if (p.checks) next.checks = { ...next.checks, state: p.checks };

  // ── Review loop ──
  switch (ev.type) {
    case "review.started":
      // The round about to be decided = the next slot in the log.
      next.review.state = "reviewing";
      next.review.currentRound = p.round ?? next.review.rounds.length + 1;
      break;
    case "review.changes_requested": {
      // Number outcomes off rounds.length so started/changes/approved never
      // disagree (with or without an explicit review.started).
      const round = p.round ?? next.review.rounds.length + 1;
      next.review.state = "changes_requested";
      next.review.currentRound = round;
      next.review.rounds = [
        ...next.review.rounds,
        { round, status: "CHANGES_REQUESTED", score: p.score, blockingComments: p.blockingComments ?? 0, completedAt: ev.createdAt },
      ];
      break;
    }
    case "review.approved": {
      const round = p.round ?? next.review.rounds.length + 1;
      next.review.state = "approved";
      next.review.currentRound = round;
      next.review.rounds = [...next.review.rounds, { round, status: "APPROVED", score: p.score, blockingComments: 0, completedAt: ev.createdAt }];
      next.verdictId = next.verdictId ?? `vd_${next.id}`;
      break;
    }
    default:
      if (p.review) next.review.state = p.review;
  }

  // ── Verification ──
  switch (ev.type) {
    case "verification.started": {
      const attempt = p.attempt ?? next.verification.attempts.length + 1;
      next.verification = {
        status: "RUNNING",
        attempts: [
          ...next.verification.attempts,
          { id: `va_${next.id}_${attempt}`, attempt, status: "RUNNING", startedAt: ev.createdAt, evidence: [] },
        ],
      };
      break;
    }
    case "verification.passed":
      next.verification = { status: "PASSED", attempts: markLastAttempt(next.verification.attempts, "PASSED", { evidence: p.evidence, criteria: p.criteria }) };
      break;
    case "verification.failed":
      next.verification = { status: "FAILED", attempts: markLastAttempt(next.verification.attempts, "FAILED", { evidence: p.evidence, criteria: p.criteria }) };
      break;
  }

  // ── "Post Video" + runtime (diagram: Make PR & Post Video; linear → MCP → runtime) ──
  if (ev.type === "pr.created" && p.evidence) next.prEvidence = p.evidence;
  if (p.runtime) next.runtime = p.runtime;

  // ── Mergeability & escalation ──
  if (p.mergeability) next.mergeability = p.mergeability;
  if (ev.type === "run.escalated" && p.escalation) next.escalation = p.escalation;

  // ── State ──
  // A resume returns to the stage the escalation paused (BUILDING/REVIEWING/MERGING).
  let to = p.toState ?? impliedState(ev.type);
  if (ev.type === "run.resumed" && !p.toState) to = run.escalation?.resumeFrom ?? "BUILDING";
  if (to) next.runState = to;
  // Leaving the blocked state clears the escalation.
  if (next.runState !== "ESCALATED") next.escalation = undefined;

  // ── Append to the event log ──
  const logEntry: RunEvent = {
    id: ev.id,
    seq: ev.seq,
    type: ev.type,
    source: ev.source,
    at: ev.createdAt,
    atMinutes: 0,
    data: p,
  };
  next.events = [...next.events, logEntry];
  next.flashSeq = ev.seq;
  next.ageMinutes = 0;

  return { ...state, cursor: ev.id, nextPr, runs: { ...state.runs, [next.id]: next } };
}

export function applyEvent(state: StoreState, ev: ShipEvent): StoreState {
  switch (ev.type) {
    case "run.created": {
      const run = ev.payload.run;
      if (!run) return state;
      const task = ev.payload.task;
      return {
        ...state,
        cursor: ev.id,
        tasks: task ? { ...state.tasks, [task.id]: task } : state.tasks,
        runs: { ...state.runs, [run.id]: { ...run, flashSeq: ev.seq } },
      };
    }
    case "flash.clear": {
      const run = state.runs[ev.runId];
      if (!run || run.flashSeq === undefined) return state;
      return { ...state, runs: { ...state.runs, [run.id]: { ...run, flashSeq: undefined } } };
    }
    case "repo.connected": {
      const repoId = ev.payload.repoId;
      if (!repoId || !state.repos[repoId]) return state;
      return { ...state, cursor: ev.id, repos: { ...state.repos, [repoId]: { ...state.repos[repoId], connected: true } } };
    }
    case "repo.added": {
      const repo = ev.payload.repo;
      if (!repo || state.repos[repo.id]) return state;
      return { ...state, cursor: ev.id, repos: { ...state.repos, [repo.id]: repo } };
    }
    case "agent.update": {
      const { memberId, config } = ev.payload;
      if (!memberId || !config || !state.members[memberId]) return state;
      return { ...state, cursor: ev.id, members: { ...state.members, [memberId]: { ...state.members[memberId], config } } };
    }
    case "message.posted": {
      const msg = ev.payload.message;
      if (!msg) return state;
      const list = state.messages[msg.channelId] ?? [];
      return { ...state, cursor: ev.id, messages: { ...state.messages, [msg.channelId]: [...list, msg] } };
    }
    case "org.update": {
      const { orgName, userName } = ev.payload;
      let members = state.members;
      if (userName && state.members[state.currentUserId]) {
        members = { ...state.members, [state.currentUserId]: { ...state.members[state.currentUserId], name: userName } };
      }
      return { ...state, cursor: ev.id, org: orgName ? { ...state.org, name: orgName } : state.org, members };
    }
    default:
      // All other typed events are run-scoped.
      return foldRun(state, ev);
  }
}
