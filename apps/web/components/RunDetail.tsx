"use client";
import React, { useState } from "react";
import Link from "next/link";
import { useApp, useAppState } from "@/lib/react";
import { selectRunDetail } from "@/lib/selectors";
import { describeEvent, ageLabel } from "@/lib/labels";
import type { RunEvent, RunState, EscalationKind, ReviewRound, Escalation, EvidenceArtifact } from "@/lib/types";
import { Icon } from "./icons";
import { StateChip, Avatar } from "./RunObject";
import { PhaseStepper } from "./PhaseStepper";

const ESCALATION_LABEL: Record<EscalationKind, string> = {
  CLARIFICATION: "Needs clarification",
  CREDENTIAL: "Missing credential",
  PERMISSION: "Needs permission",
  AUTHENTICATION: "Authentication required",
  REVIEW_LIMIT: "Stopped after the review limit",
  BUILD_LIMIT: "Stopped after too many attempts",
  EXTERNAL_FAILURE: "External failure",
  UNKNOWN: "Needs a human",
};

// A data-URI poster so evidence always renders (no external media / network).
function posterFor(a: EvidenceArtifact): string {
  const isVid = a.type === "VIDEO";
  const label = (a.label ?? a.type).slice(0, 24);
  const glyph = isVid
    ? "<circle cx='160' cy='80' r='24' fill='#12a074'/><path d='M153 69 L153 91 L174 80 Z' fill='#fff'/>"
    : "<rect x='126' y='58' width='68' height='46' rx='6' fill='none' stroke='#3aa07a' stroke-width='2'/><circle cx='160' cy='81' r='12' fill='none' stroke='#3aa07a' stroke-width='2'/>";
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='176'>` +
    `<rect width='320' height='176' fill='#0e1622'/>${glyph}` +
    `<text x='14' y='162' fill='#7f93a8' font-family='monospace' font-size='12'>${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function EvidenceGallery({ items, title }: { items?: EvidenceArtifact[]; title: string }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      <div className="rd-section">{title}</div>
      <div className="evidence-row">
        {items.map((a) => (
          <div className="evidence-item" key={a.id}>
            <img src={posterFor(a)} alt={a.label ?? a.type} />
            <div className="evidence-cap">{a.type === "VIDEO" ? "▶ " : "◍ "}{a.label ?? a.type.toLowerCase()}</div>
          </div>
        ))}
      </div>
    </>
  );
}

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
              <div className="tl-label">{d.label}<span className="when">{when}</span></div>
              <div className="tl-detail">{d.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Loop 2 — CodeReviewAgent scored review with RefineCode iterations.
function ReviewRounds({ rounds, maxRounds, provider }: { rounds: ReviewRound[]; maxRounds: number; provider?: string }) {
  if (!rounds.length) return null;
  return (
    <>
      <div className="rd-section loop-head">
        Code review <span className="loop-badge">{rounds.length} of {maxRounds} rounds</span>
        {provider && <span className="loop-badge">{provider}</span>}
      </div>
      <div className="stack">
        {rounds.map((r) => (
          <div className="round-row" key={r.round}>
            <span className="round-n">Round {r.round}</span>
            {r.score != null && <span className={`score-pill ${r.score >= 5 ? "score-good" : "score-warn"}`}>{r.score}/5</span>}
            {r.status === "APPROVED" ? (
              <span className="round-status good"><Icon name="check" size={13} /> Approved</span>
            ) : (
              <span className="round-status warn">{r.blockingComments} to fix — revised</span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// Loop 1 — Testing: ComputerUse runs the app, EvaluateState checks the desired state.
function TestingLoop({ run }: { run: RunState }) {
  const v = run.verification;
  if (v.status === "NOT_REQUIRED" || v.attempts.length === 0) return null;
  return (
    <>
      <div className="rd-section loop-head">
        Checks — proving it works <span className="loop-badge">{v.attempts.length} attempt{v.attempts.length === 1 ? "" : "s"}</span>
      </div>
      <div className="stack">
        {v.attempts.map((a) => (
          <div className="round-row" key={a.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="round-n">Attempt {a.attempt}</span>
              <span className="loop-badge">ran the app → checked the result</span>
              <span className="spring" />
              <span className={`round-status ${a.status === "PASSED" ? "good" : a.status === "FAILED" ? "crit" : ""}`}>
                {a.status === "RUNNING" ? "Running…" : a.status === "PASSED" ? "Matched what you asked for" : "Didn't match — retried"}
              </span>
            </div>
            {a.criteria && a.criteria.length > 0 && (
              <div className="crit-list">
                {a.criteria.map((c, i) => (
                  <div className="crit-item" key={i}>
                    <span className={c.ok ? "crit-ok" : "crit-x"}><Icon name={c.ok ? "check" : "close"} size={13} /></span>
                    {c.label}
                  </div>
                ))}
              </div>
            )}
            {a.evidence && a.evidence.length > 0 && (
              <div className="evidence-row">
                {a.evidence.map((e) => (
                  <div className="evidence-item" key={e.id}>
                    <img src={posterFor(e)} alt={e.label ?? e.type} />
                    <div className="evidence-cap">{e.type === "VIDEO" ? "▶ " : "◍ "}{e.label ?? e.type.toLowerCase()}</div>
                  </div>
                ))}
              </div>
            )}
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
      <p className="approval-gate">{approval.machineReady ? "Automated checks passed — ready for your review." : "Waiting on the automated checks."}</p>
      <div className="approval-checks">
        <span className={`acheck ${approval.ciGreen ? "" : "pending"}`}><Icon name="check" size={14} /> CI green</span>
        <span className={`acheck ${approval.reviewApproved ? "" : "pending"}`}><Icon name="check" size={14} /> review 5/5</span>
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
          <textarea autoFocus placeholder="What should the agent change? Be specific — it goes straight to the run." value={note} onChange={(e) => setNote(e.target.value)} />
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
  const esc: Escalation =
    run.escalation ?? {
      kind: run.runState === "FAILED" ? "EXTERNAL_FAILURE" : "UNKNOWN",
      summary: run.runState === "FAILED" ? "This run failed and needs a human to decide next steps." : "This run needs a human before it can continue.",
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
        <textarea placeholder="Optional hint to unblock the agent (e.g. which approach to take)…" value={hint} onChange={(e) => setHint(e.target.value)} style={{ minHeight: 60 }} />
      </div>
      <p className="approval-gate" style={{ margin: "0 0 10px" }}>Continue resumes the run from <b>{esc?.resumeFrom ?? "BUILDING"}</b>.</p>
      <div className="blocked-actions">
        <button className="btn btn-brand" onClick={() => app.continueRun(run.id)}><Icon name="build" size={15} /> Continue</button>
        <button className="btn btn-danger" onClick={() => app.abortRun(run.id)}><Icon name="abort" size={15} /> Abort</button>
      </div>
    </div>
  );
}

export function RunDetail({ runId, variant, onClose }: { runId: string; variant: "drawer" | "page"; onClose?: () => void }) {
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
  const linear = task?.source?.type === "linear" ? task.source : undefined;

  return (
    <div className={`rd ${variant === "page" ? "rd-page" : ""}`}>
      <div className="rd-head">
        <div style={{ flex: 1 }}>
          <h2>{run.title}</h2>
          <div className="rd-crumb">
            <span>agent</span>
            <span className="k">{agent?.handle}</span>
            {run.runtime && <><span className="sep">·</span><span className="runtime-badge">runs on {run.runtime}</span></>}
            <span className="sep">·</span>
            <span>{run.repoSlug}</span>
            {run.prNumber && (<><span className="sep">·</span><span className="pr">PR #{run.prNumber}</span></>)}
            {linear && (
              <>
                <span className="sep">·</span>
                {linear.externalUrl ? (
                  <a className="source-badge" href={linear.externalUrl} target="_blank" rel="noreferrer">{linear.externalId ?? "Linear"} ↗</a>
                ) : (
                  <span className="source-badge">from Linear</span>
                )}
              </>
            )}
          </div>
        </div>
        {variant === "drawer" && (
          <>
            <Link href={`/runs/${run.id}`} className="icon-btn" title="Open full page"><Icon name="external" size={16} /></Link>
            <button className="icon-btn" onClick={onClose} title="Close"><Icon name="close" size={16} /></button>
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

        <PhaseStepper run={run} />

        {criteria && (
          <>
            <div className="rd-section">Acceptance criteria <span className="muted" style={{ fontWeight: 400 }}>· what done looks like</span></div>
            <div className="criteria">{criteria}</div>
          </>
        )}

        <div className="rd-section">Timeline</div>
        <Timeline run={run} />

        <TestingLoop run={run} />
        {run.review.rounds.length > 0 && <ReviewRounds rounds={run.review.rounds} maxRounds={run.review.maxRounds} provider={run.review.provider ?? run.review.reviewer} />}
        <EvidenceGallery items={run.prEvidence} title="Posted with the PR" />

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
