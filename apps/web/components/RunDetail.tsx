"use client";
import React, { useState } from "react";
import Link from "next/link";
import { useApp, useAppState } from "@/lib/react";
import { selectRunDetail } from "@/lib/selectors";
import { describeEvent, ageLabel } from "@/lib/labels";
import type { RunEvent, RunState, EscalationKind, ReviewRound, Escalation } from "@/lib/types";
import { Icon } from "./icons";
import { StateChip, Avatar } from "./RunObject";

const ESCALATION_LABEL: Record<EscalationKind, string> = {
  CLARIFICATION: "Needs clarification",
  CREDENTIAL: "Missing credential",
  PERMISSION: "Needs permission",
  AUTHENTICATION: "Authentication required",
  REVIEW_LIMIT: "Hit the review-round limit",
  BUILD_LIMIT: "Hit the build-attempt limit",
  EXTERNAL_FAILURE: "External failure",
  UNKNOWN: "Needs a human",
};

function Timeline({ run }: { run: RunState }) {
  return (
    <div className="timeline">
      {run.events.map((ev: RunEvent, i: number) => {
        const d = describeEvent(ev);
        const last = i === run.events.length - 1;
        const fresh = ev.seq === run.flashSeq;
        const when = ev.atMinutes && ev.atMinutes > 0 ? `${ev.atMinutes}m ago` : "just now";
        return (
          <div key={ev.id} className={`tl-item ${fresh ? "fresh" : ""}`}>
            <div className="tl-rail">
              <span className={`tl-dot ${d.dot}`} />
              {!last && <span className="tl-line" />}
            </div>
            <div className="tl-content">
              <div className="tl-label">
                {d.label}
                <span className="when">{when}</span>
              </div>
              <div className="tl-detail">{d.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReviewRounds({ rounds, maxRounds }: { rounds: ReviewRound[]; maxRounds: number }) {
  if (!rounds.length) return null;
  return (
    <>
      <div className="rd-section">Review rounds ({rounds.length}/{maxRounds})</div>
      <div className="stack">
        {rounds.map((r) => (
          <div className="round-row" key={r.round}>
            <span className="round-n">Round {r.round}</span>
            {r.status === "APPROVED" ? (
              <span className="round-status good"><Icon name="check" size={13} /> Approved</span>
            ) : (
              <span className="round-status warn">Changes requested · {r.blockingComments} blocking</span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function VerificationSection({ run }: { run: RunState }) {
  const v = run.verification;
  if (v.status === "NOT_REQUIRED" || v.attempts.length === 0) return null; // dormant in v1
  return (
    <>
      <div className="rd-section">Functional verification</div>
      <div className="stack">
        {v.attempts.map((a) => (
          <div className="round-row" key={a.id}>
            <span className="round-n">Attempt {a.attempt}</span>
            <span className={`round-status ${a.status === "PASSED" ? "good" : a.status === "FAILED" ? "crit" : ""}`}>
              {a.status === "RUNNING" ? "Running…" : a.status === "PASSED" ? "Passed" : "Failed"}
            </span>
          </div>
        ))}
      </div>
    </>
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
  const verificationRequired = run.verification.status !== "NOT_REQUIRED";

  return (
    <div className="approval">
      <h4>Approval panel</h4>
      <p className="approval-gate">{approval.machineReady ? "Machine gates passed — ready for your review." : "Waiting on machine gates."}</p>
      <div className="approval-checks">
        <span className={`acheck ${approval.ciGreen ? "" : "pending"}`}><Icon name="check" size={14} /> CI green</span>
        <span className={`acheck ${approval.reviewApproved ? "" : "pending"}`}><Icon name="check" size={14} /> review approved</span>
        <span className={`acheck ${approval.mergeable ? "" : "pending"}`}><Icon name="check" size={14} /> no conflicts</span>
        {verificationRequired && (
          <span className={`acheck ${approval.verificationOk ? "" : "pending"}`}><Icon name="check" size={14} /> verified</span>
        )}
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
  // FAILED runs can reach this panel without a structured escalation — give it a
  // sensible fallback so the body is never empty.
  const esc: Escalation =
    run.escalation ?? {
      kind: run.runState === "FAILED" ? "EXTERNAL_FAILURE" : "UNKNOWN",
      summary:
        run.runState === "FAILED"
          ? "This run failed and needs a human to decide next steps."
          : "This run needs a human before it can continue.",
      resumeFrom: "BUILDING",
    };
  return (
    <div className="blocked-panel">
      <div className="blocked-head">
        <h4>Blocked — needs a human</h4>
        <span className="esc-kind">{ESCALATION_LABEL[esc.kind]}</span>
      </div>
      {esc.summary && <p>{esc.summary}</p>}
      {esc.question && <p className="esc-question">{esc.question}</p>}
      {esc.token && <div className="token">{esc.token}</div>}
      <div className="composer" style={{ marginTop: 0, marginBottom: 10 }}>
        <textarea
          placeholder="Optional hint to unblock the agent (e.g. which approach to take)…"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          style={{ minHeight: 60 }}
        />
      </div>
      <p className="approval-gate" style={{ margin: "0 0 10px" }}>
        Continue resumes the run from <b>{esc?.resumeFrom ?? "BUILDING"}</b>.
      </p>
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
  const { run, agent, task } = detail;
  const isAwaiting = run.runState === "AWAITING_HUMAN";
  const isBlocked = run.runState === "ESCALATED" || run.runState === "FAILED";
  const isDone = run.runState === "DONE" || run.runState === "CANCELLED";
  const criteria = task?.acceptanceCriteria?.trim();

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

        {criteria && (
          <>
            <div className="rd-section">Acceptance criteria</div>
            <div className="criteria">{criteria}</div>
          </>
        )}

        <div className="rd-section">Timeline</div>
        <Timeline run={run} />

        {run.review.rounds.length > 0 && <ReviewRounds rounds={run.review.rounds} maxRounds={run.review.maxRounds} />}
        <VerificationSection run={run} />

        {isAwaiting && <ApprovalPanel run={run} />}
        {isBlocked && <BlockedPanel run={run} />}
        {isDone && (
          <div className="approval" style={{ background: "var(--good-tint)", borderColor: "color-mix(in srgb, var(--good) 26%, var(--border))" }}>
            <h4 style={{ color: "var(--good)" }}>{run.runState === "DONE" ? "Merged & closed" : "Aborted"}</h4>
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
