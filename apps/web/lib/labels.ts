// ─────────────────────────────────────────────────────────────────────────────
// Presentation over the canonical run_state + the event→timeline formatter.
// Backend truth is a typed ShipEvent; the UI sentence is DERIVED here, never
// baked into the event. (Architecture review §2/§3)
// ─────────────────────────────────────────────────────────────────────────────
import type { RunStateName, Severity, RunState, RunEvent, ShipEventType } from "./types";

export const RUN_LABEL: Record<RunStateName, string> = {
  QUEUED: "To do",
  BUILDING: "Building",
  REVIEWING: "In review",
  AWAITING_HUMAN: "Needs approval",
  MERGING: "Merging",
  DONE: "Merged",
  ESCALATED: "Blocked",
  CANCELLED: "Aborted",
  FAILED: "Blocked",
};

export const CHIP_LABEL: Record<RunStateName, string> = {
  QUEUED: "TO DO",
  BUILDING: "BUILDING",
  REVIEWING: "IN REVIEW",
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
    case "MERGING":
      return "active";
    case "CANCELLED":
    case "QUEUED":
    default:
      return "idle";
  }
}

export const IN_FLIGHT_STATES: RunStateName[] = ["QUEUED", "BUILDING", "REVIEWING", "MERGING"];

export function isInFlight(r: RunState): boolean {
  return IN_FLIGHT_STATES.includes(r.runState);
}

export function isBlocked(r: RunState): boolean {
  return r.runState === "ESCALATED" || r.runState === "FAILED";
}

export function ageLabel(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── Event → timeline row ──────────────────────────────────────────────────────
export type DotTone = "" | "good" | "warn" | "critical" | "idle";

export interface EventDisplay {
  label: string;
  detail: string;
  dot: DotTone;
}

/** Derive the timeline label/detail/dot from a typed event's structured data. */
export function describeEvent(ev: RunEvent): EventDisplay {
  const d = ev.data ?? {};
  const fallback = d.text ?? "";
  const round = d.round;
  const attempt = d.attempt;
  switch (ev.type) {
    case "run.created":
      return { label: "Task received", detail: fallback || "Queued for an agent", dot: "idle" };
    case "sandbox.provisioning":
      return { label: "Sandbox", detail: fallback || "Provisioning an isolated environment", dot: "" };
    case "sandbox.ready":
      return { label: "Sandbox ready", detail: fallback || "Environment is up", dot: "" };
    case "sandbox.failed":
      return { label: "Sandbox failed", detail: fallback || "Could not provision the environment", dot: "critical" };
    case "agent.started":
      return { label: "Picked up", detail: fallback || "Agent started — cloned the repo", dot: "" };
    case "agent.progress":
      return { label: "Working", detail: fallback || "Editing files and running the suite", dot: "" };
    case "agent.completed":
      return { label: "Implementation", detail: fallback || "Implementation complete", dot: "" };
    case "agent.failed":
      return { label: "Agent stopped", detail: fallback || "The agent could not proceed", dot: "critical" };
    case "git.branch_created":
      return { label: "Branch", detail: fallback || "Created a working branch", dot: "" };
    case "git.commit_created":
      return { label: "Commit", detail: fallback || "Committed changes", dot: "" };
    case "git.push_completed":
      return { label: "Pushed", detail: fallback || "Pushed the branch", dot: "" };
    case "pr.created":
      return { label: "Opened PR", detail: fallback || (d.prNumber ? `Opened PR #${d.prNumber}` : "Opened a pull request"), dot: "" };
    case "ci.started":
      return { label: "CI", detail: fallback || "Checks running", dot: "" };
    case "ci.passed":
      return { label: "CI passed", detail: fallback || "Required checks are green", dot: "good" };
    case "ci.failed":
      return { label: "CI failed", detail: fallback || "Required checks failed", dot: "critical" };
    case "verification.started":
      return { label: "Verifying", detail: fallback || `Functional verification${attempt ? ` · attempt ${attempt}` : ""}`, dot: "" };
    case "verification.passed":
      return { label: "Verified", detail: fallback || `Attempt ${attempt ?? 1} passed`, dot: "good" };
    case "verification.failed":
      return { label: "Verification failed", detail: fallback || `Attempt ${attempt ?? 1} failed — back to the agent`, dot: "critical" };
    case "review.started":
      return { label: "Review", detail: fallback || `Review round ${round ?? 1}`, dot: "" };
    case "review.approved":
      return { label: "Review approved", detail: fallback || "Reviewer approved", dot: "good" };
    case "review.changes_requested":
      return {
        label: "Changes requested",
        detail: fallback || `${d.blockingComments ?? 0} blocking comment${(d.blockingComments ?? 0) === 1 ? "" : "s"} · round ${round ?? 1}`,
        dot: "warn",
      };
    case "revision.started":
      return { label: "Revising", detail: fallback || "Addressing review feedback", dot: "" };
    case "revision.pushed":
      return { label: "Pushed fixes", detail: fallback || "Pushed revisions", dot: "" };
    case "run.escalated":
      return { label: "Blocked", detail: fallback || d.escalation?.summary || "Needs a human decision", dot: "critical" };
    case "run.resumed":
      return { label: "Resumed", detail: fallback || "Continuing with your hint", dot: "" };
    case "run.cancelled":
      return { label: "Aborted", detail: fallback || "Run aborted — branch & PR kept", dot: "idle" };
    case "human.approval_requested":
      return { label: "Ready for you", detail: fallback || "All machine gates passed", dot: "warn" };
    case "human.changes_requested":
      return { label: "Changes requested", detail: fallback || "You sent it back to the agent", dot: "warn" };
    case "human.approved":
      return { label: "Approved", detail: fallback || "You approved the merge", dot: "good" };
    case "merge.started":
      return { label: "Merging", detail: fallback || "Merging into the base branch", dot: "" };
    case "merge.completed":
      return { label: "Merged", detail: fallback || "Merged & closed", dot: "good" };
    case "merge.failed":
      return { label: "Merge failed", detail: fallback || "GitHub rejected the merge", dot: "critical" };
    default:
      return { label: "Update", detail: fallback, dot: "" };
  }
}

/** Which run field a fixture Step primarily represents → its typed event. */
export function stepKindToEventType(kind: string | undefined, toState?: RunStateName): ShipEventType {
  switch (kind) {
    case "pick":
      return "agent.started";
    case "build":
      return toState === "REVIEWING" ? "revision.pushed" : "agent.progress";
    case "pr":
      return "pr.created";
    case "ci":
      return "ci.passed";
    case "review":
      return "review.changes_requested";
    case "ready":
      return "human.approval_requested";
    case "merged":
      return "merge.completed";
    case "blocked":
      return "run.escalated";
    case "abort":
      return "run.cancelled";
    default:
      return "agent.progress";
  }
}
