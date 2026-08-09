// ─────────────────────────────────────────────────────────────────────────────
// Presentation mapping over the canonical run_state. The UI shows friendly
// labels; severity is a separate axis. (FRONTEND_PLAN §0)
// ─────────────────────────────────────────────────────────────────────────────
import type { RunStateName, Severity, RunState } from "./types";

export const RUN_LABEL: Record<RunStateName, string> = {
  QUEUED: "To do",
  BUILDING: "Building",
  REVIEWING: "In review",
  REVIEW_FEEDBACK: "In review",
  AWAITING_HUMAN: "Needs approval",
  MERGING: "Merging",
  DONE: "Merged",
  ESCALATED: "Blocked",
  CANCELLED: "Aborted",
  FAILED: "Blocked",
};

/** Compact UPPERCASE chip label used on inbox rows / board cards. */
export const CHIP_LABEL: Record<RunStateName, string> = {
  QUEUED: "TO DO",
  BUILDING: "BUILDING",
  REVIEWING: "IN REVIEW",
  REVIEW_FEEDBACK: "IN REVIEW",
  AWAITING_HUMAN: "NEEDS APPROVAL",
  MERGING: "MERGING",
  DONE: "MERGED",
  ESCALATED: "BLOCKED",
  CANCELLED: "ABORTED",
  FAILED: "BLOCKED",
};

export function severityFor(state: RunStateName): Severity {
  switch (state) {
    case "AWAITING_HUMAN":
      return "warn";
    case "ESCALATED":
    case "FAILED":
      return "critical";
    case "DONE":
      return "good";
    case "BUILDING":
    case "REVIEWING":
    case "REVIEW_FEEDBACK":
    case "MERGING":
      return "active";
    case "CANCELLED":
    case "QUEUED":
    default:
      return "idle";
  }
}

/** Glyph key per milestone kind — the icon set lives in components/icons. */
export const KIND_ICON: Record<string, string> = {
  pick: "pickup",
  build: "build",
  pr: "pr",
  ci: "check",
  review: "review",
  ready: "ready",
  merged: "merged",
  blocked: "alert",
  abort: "abort",
};

/** Short human label for a milestone kind, used in the timeline left column. */
export const KIND_LABEL: Record<string, string> = {
  pick: "Picked up",
  build: "Working",
  pr: "Opened PR",
  ci: "CI passed",
  review: "Review",
  ready: "Ready for you",
  merged: "Merged",
  blocked: "Blocked",
  abort: "Aborted",
};

export const IN_FLIGHT_STATES: RunStateName[] = [
  "QUEUED",
  "BUILDING",
  "REVIEWING",
  "REVIEW_FEEDBACK",
  "MERGING",
];

export function isInFlight(r: RunState): boolean {
  return IN_FLIGHT_STATES.includes(r.runState);
}

export function isBlocked(r: RunState): boolean {
  return r.runState === "ESCALATED" || r.runState === "FAILED";
}

export function ageLabel(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
