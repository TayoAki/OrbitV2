"use client";
import React, { useState } from "react";
import { useApp, useAppState } from "@/lib/react";
import { Icon } from "./icons";
import { useUI } from "./ui";

export function NewTaskModal({ repoId, onClose }: { repoId?: string; onClose: () => void }) {
  const state = useAppState();
  const app = useApp();
  const ui = useUI();
  const connected = Object.values(state.repos).filter((r) => r.connected);
  const agents = Object.values(state.members).filter((m) => m.kind === "agent");

  const [repo, setRepo] = useState(repoId ?? connected[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState("");
  const [agentId, setAgentId] = useState<string>("");

  const canStart = repo && title.trim().length > 3;

  const start = () => {
    if (!canStart) return;
    const id = app.startTask({
      repoId: repo,
      title: title.trim(),
      acceptanceCriteria: criteria.trim() || undefined,
      agentId: agentId || undefined,
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
              <div className="field">
                <label>Repository</label>
                <select value={repo} onChange={(e) => setRepo(e.target.value)}>
                  {connected.map((r) => (
                    <option key={r.id} value={r.id}>{r.slug}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>What should be changed?</label>
                <textarea
                  autoFocus
                  placeholder="e.g. Add retry-with-backoff to the webhook sender"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="field">
                <label>How will we know it&rsquo;s done? <span className="muted" style={{ fontWeight: 400 }}>· acceptance criteria</span></label>
                <textarea
                  placeholder="e.g. Failed sends retry 3× with backoff; a test proves a transient 500 eventually succeeds"
                  value={criteria}
                  onChange={(e) => setCriteria(e.target.value)}
                  style={{ minHeight: 60 }}
                />
                <div className="field-hint">This is what the verifier will prove — the clearer it is, the better the run.</div>
              </div>
              <div className="field">
                <label>Agent</label>
                <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  <option value="">Auto-assign</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} · @{a.handle}</option>
                  ))}
                </select>
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
