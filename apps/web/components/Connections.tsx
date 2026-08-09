"use client";
import React from "react";
import { useApp, useAppState } from "@/lib/react";
import type { ConnectionStatus } from "@/lib/types";
import { Icon, type IconName } from "./icons";
import { useUI } from "./ui";

const PROVIDER_ICON: Record<string, IconName> = {
  github: "github",
  coderabbit: "review",
  slack: "threads",
};

function statusLabel(s: ConnectionStatus): string {
  if (s === "connected") return "Connected";
  if (s === "error") return "Error";
  return "Not configured";
}

export function Connections() {
  const state = useAppState();
  const app = useApp();
  const ui = useUI();
  const repos = Object.values(state.repos);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Connections</h1>
        <div className="page-sub">Repositories and the tools your agents plug into</div>
      </div>

      <div className="rd-section" style={{ marginTop: 18, display: "flex", alignItems: "center" }}>
        Repositories
        <span className="spring" />
        <button className="btn sm btn-brand" onClick={ui.openAddRepo}><Icon name="plus" size={13} /> Add repository</button>
      </div>
      <div className="stack">
        {repos.map((r) => (
          <div className="card" key={r.id}>
            <span className="conn-logo"><Icon name="github" size={20} /></span>
            <div className="grow">
              <div className="ct">{r.slug}</div>
              <div className="cs">
                default branch <span className="sha">{r.defaultBranch}</span>
                {r.connected ? " · runs are streaming into your inbox" : " · connect to pull its open runs"}
              </div>
            </div>
            {r.connected ? (
              <span className="pill-status connected">Connected</span>
            ) : (
              <button className="btn btn-brand sm" onClick={() => app.connectRepo(r.id)}>Connect</button>
            )}
          </div>
        ))}
      </div>

      <div className="rd-section" style={{ marginTop: 24 }}>Integrations</div>
      <div className="stack">
        {state.connections.map((c) => (
          <div className="card" key={c.id}>
            <span className="conn-logo"><Icon name={PROVIDER_ICON[c.provider] ?? "connections"} size={20} /></span>
            <div className="grow">
              <div className="ct">{c.displayName}</div>
              <div className="cs">
                {c.scopeSummary}
                {c.lastSyncedLabel ? ` · ${c.lastSyncedLabel}` : ""}
              </div>
            </div>
            <span className={`pill-status ${c.status}`}>{statusLabel(c.status)}</span>
            {c.status !== "connected" && (
              <button className="btn sm" onClick={() => app.toast(`${c.displayName} setup is a stub in this prototype`, "info")}>
                Configure
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="empty" style={{ marginTop: 22, textAlign: "left", display: "flex", gap: 14, alignItems: "center" }}>
        <Icon name="plus" size={22} className="muted" />
        <div>
          <h3 style={{ marginBottom: 2 }}>Start a task on a connected repo</h3>
          <p style={{ margin: 0 }}>Pick a repo and describe the task — the agent opens a PR and it lands in your inbox.</p>
        </div>
        <span className="spring" />
        <button className="btn btn-brand" onClick={() => ui.openNewTask()}>New task</button>
      </div>
    </>
  );
}
