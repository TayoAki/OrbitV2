"use client";
import React, { useEffect, useState } from "react";
import { useApp, useAppState } from "@/lib/react";
import { Icon } from "./icons";
import { useUI } from "./ui";
import { api, isLiveBackend } from "@/lib/api";
import type { AgentRuntime, TaskSource } from "@/lib/types";

const WORKSPACE_ID = "ws";
const RUNTIMES: AgentRuntime[] = ["copilot", "cursor", "cloud", "devin", "claude"];

interface LinearIssue { id: string; identifier: string; title: string; state: string; sample?: boolean }
const SAMPLE_ISSUES: LinearIssue[] = [
  { id: "s1", identifier: "ENG-412", title: "Add rate-limit headers to /export", state: "Todo", sample: true },
  { id: "s2", identifier: "ENG-418", title: "Stream chat responses instead of one blob", state: "Todo", sample: true },
  { id: "s3", identifier: "ENG-421", title: "Cache the org-settings lookup", state: "Backlog", sample: true },
];

export function NewTaskModal({ repoId, onClose }: { repoId?: string; onClose: () => void }) {
  const state = useAppState();
  const app = useApp();
  const ui = useUI();
  const connected = Object.values(state.repos).filter((r) => r.connected);
  const agents = Object.values(state.members).filter((m) => m.kind === "agent");

  const [mode, setMode] = useState<"manual" | "linear">("manual");
  const [repo, setRepo] = useState(repoId ?? connected[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState("");
  const [agentId, setAgentId] = useState<string>("");
  const [runtime, setRuntime] = useState<AgentRuntime | "">("");

  // Linear import
  const [issues, setIssues] = useState<LinearIssue[] | null>(null);
  const [picked, setPicked] = useState<LinearIssue | null>(null);
  const [linearNote, setLinearNote] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "linear" || issues) return;
    if (!isLiveBackend) { setIssues(SAMPLE_ISSUES); setLinearNote("Sample issues — connect Linear in Connections to import your real backlog."); return; }
    api.linearIssues(WORKSPACE_ID)
      .then((r) => { setIssues(r.issues.length ? r.issues : SAMPLE_ISSUES); if (!r.issues.length) setLinearNote("No open issues returned — showing samples."); })
      .catch(() => { setIssues(SAMPLE_ISSUES); setLinearNote("Linear isn't connected — showing samples. Connect it in Connections to import your backlog."); });
  }, [mode, issues]);

  const pick = (iss: LinearIssue) => { setPicked(iss); setTitle(iss.title); };

  const source: TaskSource | undefined =
    mode === "linear" && picked ? { type: "linear", externalId: picked.identifier, externalUrl: picked.sample ? undefined : `https://linear.app/issue/${picked.identifier}` } : undefined;

  const canStart = repo && title.trim().length > 3 && (mode === "manual" || !!picked);

  const start = () => {
    if (!canStart) return;
    const id = app.startTask({
      repoId: repo,
      title: title.trim(),
      acceptanceCriteria: criteria.trim() || undefined,
      agentId: agentId || undefined,
      runtime: runtime || undefined,
      source,
    });
    onClose();
    if (id) ui.openRun(id);
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Icon name="plus" size={17} className="muted" />
          <h3>New task</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>

        <div className="modal-body">
          {connected.length === 0 ? (
            <p className="muted">Connect a repository first — tasks run against a connected repo.</p>
          ) : (
            <>
              <div className="nt-tabs">
                <button className={`nt-tab ${mode === "manual" ? "on" : ""}`} onClick={() => setMode("manual")}><Icon name="plus" size={13} /> Describe it</button>
                <button className={`nt-tab ${mode === "linear" ? "on" : ""}`} onClick={() => setMode("linear")}><Icon name="connections" size={13} /> From Linear</button>
              </div>

              <div className="field">
                <label>Repository</label>
                <select value={repo} onChange={(e) => setRepo(e.target.value)}>
                  {connected.map((r) => (<option key={r.id} value={r.id}>{r.slug}</option>))}
                </select>
              </div>

              {mode === "linear" ? (
                <div className="field">
                  <label>Pick an issue</label>
                  {linearNote && <div className="field-hint" style={{ marginBottom: 8 }}>{linearNote}</div>}
                  <div className="linear-list">
                    {(issues ?? []).map((iss) => (
                      <button key={iss.id} className={`linear-issue ${picked?.id === iss.id ? "on" : ""}`} onClick={() => pick(iss)}>
                        <span className="linear-id">{iss.identifier}</span>
                        <span style={{ flex: 1 }}>{iss.title}</span>
                        <span className="linear-id">{iss.state}</span>
                      </button>
                    ))}
                    {issues && issues.length === 0 && <div className="field-hint">No issues.</div>}
                  </div>
                </div>
              ) : (
                <div className="field">
                  <label>What should be changed?</label>
                  <textarea autoFocus placeholder="e.g. Add retry-with-backoff to the webhook sender" value={title} onChange={(e) => setTitle(e.target.value)} />
                </div>
              )}

              <div className="field">
                <label>How will we know it&rsquo;s done? <span className="muted" style={{ fontWeight: 400 }}>· acceptance criteria (drives Testing)</span></label>
                <textarea placeholder="e.g. Failed sends retry 3× with backoff; a test proves a transient 500 eventually succeeds" value={criteria} onChange={(e) => setCriteria(e.target.value)} style={{ minHeight: 56 }} />
                <div className="field-hint">This is the desired state the Testing loop (ComputerUse → EvaluateState) will prove.</div>
              </div>

              <div className="field" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label>Agent</label>
                  <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                    <option value="">Auto-assign</option>
                    {agents.map((a) => (<option key={a.id} value={a.id}>{a.name} · @{a.handle}</option>))}
                  </select>
                </div>
                <div>
                  <label>Runtime <span className="muted" style={{ fontWeight: 400 }}>· via MCP</span></label>
                  <select value={runtime} onChange={(e) => setRuntime(e.target.value as AgentRuntime | "")}>
                    <option value="">Agent default</option>
                    {RUNTIMES.map((r) => (<option key={r} value={r}>{r}</option>))}
                  </select>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-brand" disabled={!canStart} onClick={start}>
            <Icon name="arrowRight" size={15} /> Start task
          </button>
        </div>
      </div>
    </div>
  );
}
