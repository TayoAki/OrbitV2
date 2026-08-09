"use client";
import React, { useState } from "react";
import Link from "next/link";
import { useApp, useAppState } from "@/lib/react";
import { selectRunDetail } from "@/lib/selectors";
import { KIND_LABEL, ageLabel } from "@/lib/labels";
import type { Milestone, RunState } from "@/lib/types";
import { Icon } from "./icons";
import { StateChip, Avatar } from "./RunObject";

function dotTone(kind: string): string {
  switch (kind) {
    case "ready":
      return "warn";
    case "blocked":
    case "abort":
      return "critical";
    case "merged":
    case "ci":
      return "good";
    case "pick":
      return "idle";
    default:
      return "";
  }
}

function Timeline({ run }: { run: RunState }) {
  return (
    <div className="timeline">
      {run.milestones.map((m: Milestone, i: number) => {
        const last = i === run.milestones.length - 1;
        const fresh = m.seq !== undefined && m.seq === run.flashSeq;
        const when = m.atMinutes && m.atMinutes > 0 ? `${m.atMinutes}m ago` : "just now";
        return (
          <div key={i} className={`tl-item ${fresh ? "fresh" : ""}`}>
            <div className="tl-rail">
              <span className={`tl-dot ${dotTone(m.kind)}`} />
              {!last && <span className="tl-line" />}
            </div>
            <div className="tl-content">
              <div className="tl-label">
                {KIND_LABEL[m.kind] ?? "Update"}
                <span className="when">{when}</span>
              </div>
              <div className="tl-detail">{m.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Evidence() {
  // Decorative before→after thumbnails. Real screenshots arrive from the run's
  // artifact bucket in production; here we sketch the shape.
  return (
    <div className="evidence">
      <div className="thumb">
        <div className="cap">Before</div>
        <div className="shot" style={{ background: "repeating-linear-gradient(135deg, var(--surface-3), var(--surface-3) 8px, var(--surface-2) 8px, var(--surface-2) 16px)" }}>
          <Icon name="alert" size={20} className="muted" />
        </div>
      </div>
      <div className="arrow"><Icon name="arrowRight" size={18} /></div>
      <div className="thumb">
        <div className="cap">After</div>
        <div className="shot" style={{ background: "var(--brand-tint)" }}>
          <Icon name="checkCircle" size={22} />
        </div>
      </div>
    </div>
  );
}

function ApprovalPanel({ run }: { run: RunState }) {
  const state = useAppState();
  const app = useApp();
  const detail = selectRunDetail(state, run.id)!;
  const { approval, agent, requester } = detail;
  const [composer, setComposer] = useState(false);
  const [note, setNote] = useState("");

  const send = () => {
    app.requestChanges(run.id, note.trim() || undefined);
    setComposer(false);
    setNote("");
  };

  return (
    <div className="approval">
      <h4>Approval panel</h4>
      <div className="approval-checks">
        <span className={`acheck ${approval.ciGreen ? "" : "pending"}`}><Icon name="check" size={14} /> CI green</span>
        <span className={`acheck ${approval.reviewApproved ? "" : "pending"}`}><Icon name="check" size={14} /> review approved</span>
        <span className={`acheck ${approval.noConflicts ? "" : "pending"}`}><Icon name="check" size={14} /> no conflicts</span>
      </div>
      <p className="approval-prov">
        Requested by <span className="k">@{requester?.handle}</span> · built by agent{" "}
        <span className="k">{agent?.handle}</span>. Approving merges PR{" "}
        <span className="k">#{run.prNumber}</span> into {run.targetBranch} and re-checks your GitHub access.
      </p>

      {!composer ? (
        <div className="approval-actions">
          <button className="btn btn-approve" disabled={!approval.canApprove} onClick={() => app.approve(run.id)}>
            <Icon name="merge" size={15} /> Approve &amp; merge
          </button>
          <button className="btn" onClick={() => setComposer(true)}>Request changes</button>
        </div>
      ) : (
        <div className="composer">
          <textarea
            autoFocus
            placeholder="What should the agent change? Be specific — it goes straight to the run."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="composer-actions">
            <button className="btn" onClick={() => setComposer(false)}>Cancel</button>
            <button className="btn btn-brand" onClick={send}>Send to agent</button>
          </div>
        </div>
      )}
    </div>
  );
}

function BlockedPanel({ run }: { run: RunState }) {
  const app = useApp();
  const [hint, setHint] = useState("");
  return (
    <div className="blocked-panel">
      <h4>Blocked — needs a human</h4>
      {run.blockedReason?.summary && <p>{run.blockedReason.summary}</p>}
      {run.blockedReason?.token && <div className="token">{run.blockedReason.token}</div>}
      <div className="composer" style={{ marginTop: 0, marginBottom: 12 }}>
        <textarea
          placeholder="Optional hint to unblock the agent (e.g. which approach to take)…"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          style={{ minHeight: 60 }}
        />
      </div>
      <div className="blocked-actions">
        <button className="btn btn-brand" onClick={() => app.continueRun(run.id)}>
          <Icon name="build" size={15} /> Continue
        </button>
        <button className="btn btn-danger" onClick={() => app.abortRun(run.id)}>
          <Icon name="abort" size={15} /> Abort
        </button>
      </div>
    </div>
  );
}

export function RunDetail({
  runId,
  variant,
  onClose,
}: {
  runId: string;
  variant: "drawer" | "page";
  onClose?: () => void;
}) {
  const state = useAppState();
  const detail = selectRunDetail(state, runId);
  if (!detail) {
    return (
      <div className={`rd ${variant === "page" ? "rd-page" : ""}`}>
        <div className="rd-head"><h2>Run not found</h2></div>
        <div className="rd-body"><p className="muted">This run is not in the current workspace.</p></div>
      </div>
    );
  }
  const { run, agent } = detail;
  const isAwaiting = run.runState === "AWAITING_HUMAN";
  const isBlocked = run.runState === "ESCALATED" || run.runState === "FAILED";
  const isDone = run.runState === "DONE" || run.runState === "CANCELLED";

  return (
    <div className={`rd ${variant === "page" ? "rd-page" : ""}`}>
      <div className="rd-head">
        <div style={{ flex: 1 }}>
          <h2>{run.title}</h2>
          <div className="rd-crumb">
            <span>agent</span>
            <span className="k">{agent?.handle}</span>
            <span className="sep">·</span>
            <span>{run.repoSlug}</span>
            {run.prNumber && (
              <>
                <span className="sep">·</span>
                <span className="pr">PR #{run.prNumber}</span>
              </>
            )}
          </div>
        </div>
        {variant === "drawer" && (
          <>
            <Link href={`/runs/${run.id}`} className="icon-btn" title="Open full page">
              <Icon name="external" size={16} />
            </Link>
            <button className="icon-btn" onClick={onClose} title="Close">
              <Icon name="close" size={16} />
            </button>
          </>
        )}
      </div>

      <div className="rd-body">
        <div className="rd-chiprow">
          <StateChip run={run} />
          <span className="time">{ageLabel(run.ageMinutes)} old</span>
          <span className="spring" />
          {variant === "drawer" && (
            <Link href={`/runs/${run.id}`} className="link" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              Open full page <Icon name="external" size={13} />
            </Link>
          )}
        </div>

        <div className="rd-section">Milestone timeline</div>
        <Timeline run={run} />

        {isAwaiting && run.diffStat && (
          <>
            <div className="rd-section">Evidence (before → after)</div>
            <Evidence />
          </>
        )}

        {isAwaiting && <ApprovalPanel run={run} />}
        {isBlocked && <BlockedPanel run={run} />}
        {isDone && (
          <div className="approval" style={{ background: "var(--good-tint)", borderColor: "color-mix(in srgb, var(--good) 26%, var(--border))" }}>
            <h4 style={{ color: "var(--good)" }}>
              {run.runState === "DONE" ? "Merged & closed" : "Aborted"}
            </h4>
            <p className="approval-prov" style={{ marginBottom: 0 }}>
              {run.runState === "DONE"
                ? `PR #${run.prNumber} was merged into ${run.targetBranch}. Nothing else needs you.`
                : "This run was aborted. Its branch and PR were kept for reference."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
