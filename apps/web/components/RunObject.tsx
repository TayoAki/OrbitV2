"use client";
import React from "react";
import type { Member, RunState, RunStateName, Severity } from "@/lib/types";
import { CHIP_LABEL, severityFor, ageLabel } from "@/lib/labels";
import { useAppState } from "@/lib/react";
import { Icon, type IconName } from "./icons";

// ── Avatar ───────────────────────────────────────────────────────────────────
const AVATAR_COLORS = ["#5b8def", "#e0699a", "#e0913a", "#43b581", "#8e6fe0", "#3aa0b8", "#d15b5b", "#7a8794"];
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function Avatar({
  member,
  size = 26,
  status,
}: {
  member: Member;
  size?: number;
  status?: Severity;
}) {
  return (
    <span
      className={`avatar ${member.kind === "agent" ? "agent" : ""}`}
      style={{ width: size, height: size, background: colorFor(member.id), fontSize: Math.round(size * 0.4) }}
      title={member.name}
    >
      {member.initials}
      {status && <span className={`status-dot ${status}`} />}
    </span>
  );
}

// ── State chip ───────────────────────────────────────────────────────────────
type ChipTone = "warn" | "critical" | "info" | "good" | "active" | "idle";
export function chipTone(state: RunStateName): ChipTone {
  switch (state) {
    case "AWAITING_HUMAN":
      return "warn";
    case "ESCALATED":
    case "FAILED":
      return "critical";
    case "BUILDING":
    case "REVIEWING":
    case "REVIEW_FEEDBACK":
      return "info";
    case "MERGING":
      return "active";
    case "DONE":
      return "good";
    default:
      return "idle";
  }
}

export function StateChip({ run }: { run: RunState }) {
  const tone = chipTone(run.runState);
  const pulsing = run.runState === "MERGING";
  return (
    <span className={`chip ${tone}`}>
      {pulsing && <span className="pulse" />}
      {CHIP_LABEL[run.runState]}
    </span>
  );
}

// ── Row glyph ────────────────────────────────────────────────────────────────
function runGlyph(run: RunState): { icon: IconName; tone: string } {
  switch (run.runState) {
    case "AWAITING_HUMAN":
      return { icon: "ready", tone: "warn" };
    case "ESCALATED":
    case "FAILED":
      return { icon: "alert", tone: "critical" };
    case "REVIEWING":
    case "REVIEW_FEEDBACK":
      return { icon: "review", tone: "info" };
    case "MERGING":
      return { icon: "merge", tone: "active" };
    case "DONE":
      return { icon: "merge", tone: "good" };
    case "QUEUED":
      return { icon: "pickup", tone: "idle" };
    default:
      return { icon: "build", tone: "active" };
  }
}

function DiffStat({ run }: { run: RunState }) {
  if (!run.diffStat) return null;
  return (
    <div className="diff">
      <span className="add">+{run.diffStat.additions}</span>
      <span className="del">−{run.diffStat.deletions}</span>
    </div>
  );
}

// In-flight progress hint, derived from the run's current state + milestones.
function Progress({ run }: { run: RunState }) {
  const ms = run.milestones.length;
  if (run.runState === "REVIEWING" || run.runState === "REVIEW_FEEDBACK") {
    const rounds = run.review.rounds ?? 1;
    return (
      <div className="progress">
        <span className="plabel">review {Math.min(rounds, 3)}/3</span>
        <span className="bar"><span className="bar-fill info" style={{ width: `${Math.min(100, (rounds / 3) * 100)}%` }} /></span>
      </div>
    );
  }
  if (run.runState === "MERGING") {
    return (
      <div className="progress">
        <span className="plabel">merging…</span>
        <span className="bar"><span className="bar-fill" style={{ width: "92%" }} /></span>
      </div>
    );
  }
  if (run.runState === "QUEUED") {
    return <div className="progress"><span className="plabel">queued</span></div>;
  }
  // BUILDING
  const pct = Math.min(88, 26 + ms * 16);
  const ciLabel = run.checks.total ? `CI ${run.checks.passed ?? 0}/${run.checks.total}` : "tests running";
  return (
    <div className="progress">
      <span className="plabel">{ciLabel} · {pct}%</span>
      <span className="bar"><span className="bar-fill" style={{ width: `${pct}%` }} /></span>
    </div>
  );
}

function RowMid({ run }: { run: RunState }) {
  if (run.runState === "AWAITING_HUMAN") {
    return (
      <>
        {run.review.state === "approved" && (
          <div className="verdict"><Icon name="check" size={14} /> Approved by review</div>
        )}
        <DiffStat run={run} />
      </>
    );
  }
  if (run.runState === "DONE") {
    return (
      <>
        <div className="verdict"><Icon name="check" size={14} /> Merged</div>
        <DiffStat run={run} />
      </>
    );
  }
  if (run.runState === "ESCALATED" || run.runState === "FAILED") {
    return run.blockedReason?.token ? <div className="diff" style={{ color: "var(--critical)" }}>{run.blockedReason.token}</div> : null;
  }
  return <Progress run={run} />;
}

// ── Inbox row ────────────────────────────────────────────────────────────────
export function RunRow({
  run,
  onOpen,
  selected,
}: {
  run: RunState;
  onOpen: (id: string) => void;
  selected?: boolean;
}) {
  const state = useAppState();
  const agent = state.members[run.agentId];
  const requester = state.members[run.requestedById];
  const glyph = runGlyph(run);
  const sev = severityFor(run.runState);
  const blocked = run.runState === "ESCALATED" || run.runState === "FAILED";
  const repoShort = run.repoSlug.split("/").pop();
  const flash = run.flashSeq !== undefined;

  return (
    <div
      className={`row ${selected ? "selected" : ""} ${blocked ? "blocked" : ""} ${flash ? "flash" : ""}`}
      onClick={() => onOpen(run.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(run.id);
      }}
    >
      <span className="row-check" role="checkbox" aria-checked="false" onClick={(e) => e.stopPropagation()} />
      <span className={`row-icon ${glyph.tone}`}><Icon name={glyph.icon} size={15} /></span>

      <div className="row-main">
        <div className="row-title">{run.title}</div>
        <div className="row-meta">
          <span className="pr">#{run.prNumber ?? "—"}</span>
          <span className="sep">·</span>
          <span>{repoShort}</span>
          <span className="sep">·</span>
          <span className="handle">@{agent?.handle}</span>
          {run.headSha && (
            <>
              <span className="sep">·</span>
              <span className="sha">{run.headSha}</span>
            </>
          )}
        </div>
      </div>

      <div className="row-mid"><RowMid run={run} /></div>

      <div className="row-right">
        <StateChip run={run} />
        <span className="time">{ageLabel(run.ageMinutes)}</span>
        {requester && <Avatar member={requester} size={26} status={sev} />}
        <span className="chev"><Icon name="chevronRight" size={16} /></span>
      </div>
    </div>
  );
}

// ── Board card ───────────────────────────────────────────────────────────────
export function BoardCard({ run, onOpen }: { run: RunState; onOpen: (id: string) => void }) {
  const state = useAppState();
  const requester = state.members[run.requestedById];
  const sev = severityFor(run.runState);
  const repoShort = run.repoSlug.split("/").pop();
  return (
    <div className="bcard" onClick={() => onOpen(run.id)}>
      <div className="bt">{run.title}</div>
      <div className="row-meta" style={{ marginBottom: 10 }}>
        <span className="pr">#{run.prNumber ?? "—"}</span>
        <span className="sep">·</span>
        <span>{repoShort}</span>
      </div>
      <div className="bm">
        <StateChip run={run} />
        {requester && <Avatar member={requester} size={22} status={sev} />}
      </div>
    </div>
  );
}
