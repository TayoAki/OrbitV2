// ─────────────────────────────────────────────────────────────────────────────
// The fold. Pure: (state, event) -> state. No timers, no React. The sim engine
// (lib/sim) is what emits ordered events; this file only interprets them.
// ─────────────────────────────────────────────────────────────────────────────
import type { ShipEvent, StoreState, RunState, Step, Milestone } from "./types";

function pseudoSha(id: string, seq: number): string {
  let h = 2166136261;
  const s = `${id}:${seq}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(7, "0").slice(0, 7);
}

function interpolate(note: string, run: RunState): string {
  return note
    .replace(/\{pr\}/g, run.prNumber ? String(run.prNumber) : "")
    .replace(/\{repo\}/g, run.repoSlug);
}

/** Apply one timeline step to a run, returning a new run object. */
function applyStep(run: RunState, step: Step, seq: number, nextPr: number): { run: RunState; prConsumed: boolean } {
  const next: RunState = {
    ...run,
    checks: { ...run.checks },
    review: { ...run.review },
    milestones: run.milestones.slice(),
  };
  let prConsumed = false;

  if (step.setPr && !next.prNumber) {
    next.prNumber = nextPr;
    // In prod the control plane assigns headSha when it opens the PR. Here we
    // derive a deterministic short sha so client-R8 has something to bind to.
    next.headSha = pseudoSha(next.id, seq);
    prConsumed = true;
  }
  if (step.checks) {
    next.checks = { ...next.checks, state: step.checks };
  }
  if (step.review) {
    next.review = { ...next.review, state: step.review };
    if (step.review === "approved") next.verdictId = next.verdictId ?? `vd_${next.id}`;
  }
  if (step.to) {
    next.runState = step.to;
  }
  if (step.note) {
    const m: Milestone = {
      kind: step.kind ?? "build",
      text: interpolate(step.note, next),
      atMinutes: 0,
      seq,
    };
    next.milestones = [...next.milestones, m];
  }
  next.ageMinutes = 0;
  next.flashSeq = seq;
  return { run: next, prConsumed };
}

export function applyEvent(state: StoreState, ev: ShipEvent): StoreState {
  switch (ev.type) {
    case "created": {
      const run = ev.payload.run;
      if (!run) return state;
      return {
        ...state,
        seq: ev.seq,
        runs: { ...state.runs, [run.id]: { ...run, flashSeq: ev.seq } },
      };
    }
    case "step": {
      const run = state.runs[ev.runId];
      const step = ev.payload.step;
      if (!run || !step) return state;
      const { run: nextRun, prConsumed } = applyStep(run, step, ev.seq, state.nextPr);
      return {
        ...state,
        seq: ev.seq,
        nextPr: prConsumed ? state.nextPr + 1 : state.nextPr,
        runs: { ...state.runs, [run.id]: nextRun },
      };
    }
    case "flash.clear": {
      const run = state.runs[ev.runId];
      if (!run || run.flashSeq === undefined) return state;
      return {
        ...state,
        runs: { ...state.runs, [run.id]: { ...run, flashSeq: undefined } },
      };
    }
    case "repo.connected": {
      const repoId = ev.payload.repoId;
      if (!repoId || !state.repos[repoId]) return state;
      return {
        ...state,
        seq: ev.seq,
        repos: { ...state.repos, [repoId]: { ...state.repos[repoId], connected: true } },
      };
    }
    case "repo.added": {
      const repo = ev.payload.repo;
      if (!repo || state.repos[repo.id]) return state;
      return {
        ...state,
        seq: ev.seq,
        repos: { ...state.repos, [repo.id]: repo },
      };
    }
    case "agent.update": {
      const { memberId, config } = ev.payload;
      if (!memberId || !config || !state.members[memberId]) return state;
      return {
        ...state,
        seq: ev.seq,
        members: { ...state.members, [memberId]: { ...state.members[memberId], config } },
      };
    }
    case "message.posted": {
      const msg = ev.payload.message;
      if (!msg) return state;
      const list = state.messages[msg.channelId] ?? [];
      return {
        ...state,
        seq: ev.seq,
        messages: { ...state.messages, [msg.channelId]: [...list, msg] },
      };
    }
    case "org.update": {
      const { orgName, userName } = ev.payload;
      let members = state.members;
      if (userName && state.members[state.currentUserId]) {
        members = {
          ...state.members,
          [state.currentUserId]: { ...state.members[state.currentUserId], name: userName },
        };
      }
      return {
        ...state,
        seq: ev.seq,
        org: orgName ? { ...state.org, name: orgName } : state.org,
        members,
      };
    }
    default:
      return state;
  }
}
