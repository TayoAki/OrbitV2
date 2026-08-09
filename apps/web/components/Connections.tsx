"use client";
import React, { useCallback, useEffect, useState } from "react";
import { useApp, useAppState } from "@/lib/react";
import type { ConnectionStatus } from "@/lib/types";
import { Icon, type IconName } from "./icons";
import { useUI } from "./ui";
import { api, isLiveBackend, type PublicConnector } from "@/lib/api";

// Single-workspace demo; connectors are keyed by workspace on the backend.
const WORKSPACE_ID = "ws";

const PROVIDER_ICON: Record<string, IconName> = {
  github: "github",
  coderabbit: "review",
  greptile: "review",
  linear: "connections",
  slack: "threads",
};

function statusLabel(s: string): string {
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
      {isLiveBackend ? <LiveIntegrations /> : <SimIntegrations />}

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

// ── Simulated integrations (no backend configured) ───────────────────────────
function SimIntegrations() {
  const state = useAppState();
  const app = useApp();
  return (
    <div className="stack">
      {state.connections.map((c) => (
        <div className="card" key={c.id}>
          <span className="conn-logo"><Icon name={PROVIDER_ICON[c.provider] ?? "connections"} size={20} /></span>
          <div className="grow">
            <div className="ct">{c.displayName}</div>
            <div className="cs">{c.scopeSummary}{c.lastSyncedLabel ? ` · ${c.lastSyncedLabel}` : ""}</div>
          </div>
          <span className={`pill-status ${c.status}`}>{statusLabel(c.status as ConnectionStatus)}</span>
          {c.status !== "connected" && (
            <button className="btn sm" onClick={() => app.toast(`${c.displayName} setup is a stub in this prototype`, "info")}>Configure</button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Live integrations — real Linear / CodeRabbit / Greptile connectors ───────
function LiveIntegrations() {
  const app = useApp();
  const [connectors, setConnectors] = useState<PublicConnector[] | null>(null);
  const [modal, setModal] = useState<PublicConnector | null>(null);

  const refresh = useCallback(() => {
    api.listConnectors(WORKSPACE_ID).then((r) => setConnectors(r.connectors)).catch((e) => {
      app.toast(`Couldn't reach the control plane: ${(e as Error).message}`, "critical");
      setConnectors([]);
    });
  }, [app]);

  useEffect(() => { refresh(); }, [refresh]);

  const onTest = async (c: PublicConnector) => {
    try {
      const r = await api.testConnector(c.provider, WORKSPACE_ID);
      app.toast(r.ok ? `${c.displayName}: ${r.account ?? "connected"}` : `${c.displayName}: ${r.detail}`, r.ok ? "good" : "critical");
      refresh();
    } catch (e) { app.toast((e as Error).message, "critical"); }
  };
  const onDisconnect = async (c: PublicConnector) => {
    try { await api.disconnectConnector(c.provider, WORKSPACE_ID); app.toast(`${c.displayName} disconnected`, "info"); refresh(); }
    catch (e) { app.toast((e as Error).message, "critical"); }
  };

  if (!connectors) return <div className="stack"><div className="card"><div className="cs">Loading connectors…</div></div></div>;

  return (
    <>
      <div className="stack">
        {connectors.map((c) => (
          <div className="card" key={c.provider}>
            <span className="conn-logo"><Icon name={PROVIDER_ICON[c.provider] ?? "connections"} size={20} /></span>
            <div className="grow">
              <div className="ct">{c.displayName} <span className="cs" style={{ fontWeight: 400 }}>· {c.category}</span></div>
              <div className="cs">
                {c.status === "connected"
                  ? `${c.accountLabel ?? "Connected"}${c.detail ? ` · ${c.detail}` : ""}`
                  : c.status === "error"
                    ? c.detail ?? "Connection error"
                    : "Not connected — add an API key to go live"}
              </div>
            </div>
            <span className={`pill-status ${c.status}`}>{statusLabel(c.status)}</span>
            {c.status === "connected" ? (
              <>
                <button className="btn sm" onClick={() => onTest(c)}>Test</button>
                <button className="btn sm" onClick={() => onDisconnect(c)}>Disconnect</button>
              </>
            ) : (
              <button className="btn btn-brand sm" onClick={() => setModal(c)}>Connect</button>
            )}
          </div>
        ))}
      </div>
      {modal && <ConnectModal connector={modal} onClose={() => setModal(null)} onConnected={() => { setModal(null); refresh(); }} />}
    </>
  );
}

function ConnectModal({ connector, onClose, onConnected }: { connector: PublicConnector; onClose: () => void; onConnected: () => void }) {
  const app = useApp();
  const [apiKey, setApiKey] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!apiKey.trim()) { setError("Enter an API key"); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.connectConnector(connector.provider, WORKSPACE_ID, apiKey.trim(), connector.needsGithubToken ? githubToken.trim() : undefined);
      if (r.ok) { app.toast(`${connector.displayName} connected${r.account ? ` — ${r.account}` : ""}`, "good"); onConnected(); }
      else { setError(r.detail || "The provider rejected that key"); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--line, #d9e0ee)",
    background: "var(--panel-2, #f4f6fb)", color: "inherit", font: "inherit", marginTop: 6,
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(6,16,12,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300 }} onClick={onClose}>
      <div style={{ width: 440, maxWidth: "92vw", background: "var(--panel, #fff)", color: "inherit", borderRadius: 16, border: "1px solid var(--line, #d9e0ee)", boxShadow: "0 20px 60px rgba(0,0,0,.35)", padding: 22 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <span className="conn-logo"><Icon name={PROVIDER_ICON[connector.provider] ?? "connections"} size={20} /></span>
          <h3 style={{ margin: 0 }}>Connect {connector.displayName}</h3>
        </div>
        <p className="cs" style={{ marginTop: 0 }}>
          Your key is validated against the live {connector.displayName} API and stored encrypted in the control plane. It never touches the browser again.
        </p>
        <label className="cs" style={{ display: "block", marginTop: 10 }}>
          {connector.displayName} API key
          <input style={inputStyle} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={connector.provider === "linear" ? "lin_api_…" : connector.provider === "coderabbit" ? "cr-…" : "grp_…"} autoFocus />
        </label>
        {connector.needsGithubToken && (
          <label className="cs" style={{ display: "block", marginTop: 12 }}>
            GitHub token (Greptile needs repo access)
            <input style={inputStyle} type="password" value={githubToken} onChange={(e) => setGithubToken(e.target.value)} placeholder="ghp_…" />
          </label>
        )}
        {error && <div style={{ marginTop: 12, color: "#d5455f", fontSize: ".85rem" }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-brand" onClick={submit} disabled={busy}>{busy ? "Validating…" : "Connect"}</button>
        </div>
      </div>
    </div>
  );
}
