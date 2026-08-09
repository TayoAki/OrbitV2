"use client";
import React, { useState } from "react";
import { useApp, useAppState } from "@/lib/react";
import { Icon } from "./icons";
import { useUI } from "./ui";

// "Add a repository" — in production this lists repos from the GitHub App
// installation; here you type an owner/name slug and it's added + connected.
export function AddRepoModal({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const app = useApp();
  const ui = useUI();
  const agents = Object.values(state.members).filter((m) => m.kind === "agent");

  const [slug, setSlug] = useState("");
  const [branch, setBranch] = useState("main");
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? "");

  const existing = new Set(Object.values(state.repos).map((r) => r.slug.toLowerCase()));
  const valid = /^[\w.-]+\/[\w.-]+$/.test(slug.trim());
  const dupe = existing.has(slug.trim().toLowerCase());
  const canAdd = valid && !dupe;

  const add = () => {
    if (!canAdd) return;
    const id = app.addRepo({ slug: slug.trim(), defaultBranch: branch.trim() || "main", agentId: agentId || undefined });
    ui.setScopeRepo(id);
    onClose();
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Icon name="github" size={18} className="muted" />
          <h3>Add a repository</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>Repository</label>
            <input
              autoFocus
              placeholder="owner/name  ·  e.g. acme/billing"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            {slug.trim() && !valid && <div className="field-hint bad">Use the <span className="sha">owner/name</span> form.</div>}
            {dupe && <div className="field-hint bad">That repository is already added.</div>}
            {canAdd && <div className="field-hint ok">Will be connected and scoped to immediately.</div>}
          </div>
          <div className="field-row">
            <div className="field">
              <label>Default branch</label>
              <input value={branch} onChange={(e) => setBranch(e.target.value)} />
            </div>
            <div className="field">
              <label>Default agent</label>
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field-note">
            <Icon name="connections" size={14} /> Uses your connected GitHub account. A repo-scoped token is issued per run — never stored in the sandbox.
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-brand" disabled={!canAdd} onClick={add}>
            <Icon name="plus" size={15} /> Add repository
          </button>
        </div>
      </div>
    </div>
  );
}
