"use client";
import React, { useMemo, useRef, useState } from "react";
import { useApp, useAppState } from "@/lib/react";
import type { AgentConfig, AgentRuntime, McpServer } from "@/lib/types";
import { Icon } from "./icons";
import { Avatar } from "./RunObject";

const MODELS = ["claude-opus-4.8", "claude-sonnet-4.5", "claude-haiku-4.5", "gpt-5-codex", "local:qwen-coder"];
const RUNTIMES: AgentRuntime[] = ["copilot", "cursor", "cloud", "devin", "claude"];

// Editor for an agent's runtime config, modeled on the buzz-agent vision:
// an ACP agent that calls an LLM and uses MCP tools, with a concurrency cap and
// a relay URL that selects its community.
export function AgentEditor({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const state = useAppState();
  const app = useApp();
  const member = state.members[memberId];
  const original = member?.config;

  const [cfg, setCfg] = useState<AgentConfig | null>(() => {
    if (!original) return null;
    const c = structuredClone(original);
    c.mcpServers = c.mcpServers.map((s, i) => ({ ...s, id: s.id ?? `mcp_${i}` }));
    return c;
  });
  const idCounter = useRef(0);

  const dirty = useMemo(
    () => (cfg && original ? JSON.stringify(cfg) !== JSON.stringify(original) : false),
    [cfg, original],
  );

  if (!member || !cfg) {
    return (
      <div className="rd">
        <div className="rd-head"><h2>Agent not found</h2></div>
      </div>
    );
  }

  const set = (patch: Partial<AgentConfig>) => setCfg((c) => (c ? { ...c, ...patch } : c));
  const setServer = (i: number, patch: Partial<McpServer>) =>
    setCfg((c) => (c ? { ...c, mcpServers: c.mcpServers.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : c));
  const removeServer = (i: number) => setCfg((c) => (c ? { ...c, mcpServers: c.mcpServers.filter((_, j) => j !== i) } : c));
  const addServer = () =>
    setCfg((c) =>
      c ? { ...c, mcpServers: [...c.mcpServers, { id: `mcp_new_${(idCounter.current += 1)}`, name: "new-mcp", command: "", tools: [] }] } : c,
    );
  const removeTool = (i: number, tool: string) => setServer(i, { tools: cfg.mcpServers[i].tools.filter((t) => t !== tool) });
  const addTool = (i: number, tool: string) => {
    const t = tool.trim();
    if (t && !cfg.mcpServers[i].tools.includes(t)) setServer(i, { tools: [...cfg.mcpServers[i].tools, t] });
  };

  const save = () => {
    app.updateAgent(memberId, cfg);
    onClose();
  };

  const models = MODELS.includes(cfg.model) ? MODELS : [cfg.model, ...MODELS];

  return (
    <div className="rd">
      <div className="rd-head">
        <Avatar member={member} size={38} status={cfg.presence === "online" ? "good" : cfg.presence === "idle" ? "warn" : "idle"} />
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: 16 }}>{member.name}</h2>
          <div className="rd-crumb">
            <span className="k">@{member.handle}</span>
            <span className="sep">·</span>
            <span>ACP agent</span>
            <span className="sep">·</span>
            <span>reports ACP {cfg.acpVersion}</span>
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
      </div>

      <div className="rd-body">
        <div className="ae-grid">
          <div className="field">
            <label>Model</label>
            <select value={cfg.model} onChange={(e) => set({ model: e.target.value })}>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="field-hint">Swapped with one env var in prod.</div>
          </div>
          <div className="field">
            <label>Runtime</label>
            <select value={cfg.runtime ?? "copilot"} onChange={(e) => set({ runtime: e.target.value as AgentRuntime })}>
              {RUNTIMES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <div className="field-hint">The cloud agent that executes the build — reached over MCP.</div>
          </div>
          <div className="field">
            <label>Presence</label>
            <select value={cfg.presence} onChange={(e) => set({ presence: e.target.value as AgentConfig["presence"] })}>
              <option value="online">online</option>
              <option value="idle">idle</option>
              <option value="offline">offline</option>
            </select>
          </div>
          <div className="field">
            <label>Max concurrent sessions</label>
            <input
              type="number"
              min={1}
              max={32}
              value={cfg.maxSessions}
              onChange={(e) => set({ maxSessions: Math.max(1, Math.min(32, Number(e.target.value) || 1)) })}
            />
            <div className="field-hint">buzz default is 8 — each session gets its own MCP servers.</div>
          </div>
          <div className="field">
            <label>Autonomy</label>
            <div className="seg">
              {(["supervised", "autonomous"] as const).map((a) => (
                <button key={a} className={cfg.autonomy === a ? "on" : ""} onClick={() => set({ autonomy: a })}>{a}</button>
              ))}
            </div>
            <div className="field-hint">{cfg.autonomy === "supervised" ? "A human approves every merge." : "Merges on green checks without waiting."}</div>
          </div>
        </div>

        <div className="rd-section">Community (Nostr relay)</div>
        <div className="ae-grid">
          <div className="field">
            <label>Relay URL</label>
            <input value={cfg.relayUrl} onChange={(e) => set({ relayUrl: e.target.value })} />
            <div className="field-hint">The relay URL selects the community the agent joins.</div>
          </div>
          <div className="field">
            <label>Community</label>
            <input value={cfg.community} onChange={(e) => set({ community: e.target.value })} />
          </div>
        </div>

        <div className="rd-section" style={{ display: "flex", alignItems: "center" }}>
          MCP servers
          <span className="spring" />
          <button className="btn sm" onClick={addServer}><Icon name="plus" size={13} /> Add server</button>
        </div>
        <div className="stack">
          {cfg.mcpServers.map((s, i) => (
            <div className="mcp-card" key={s.id ?? i}>
              <div className="mcp-row">
                <input className="mcp-name" value={s.name} onChange={(e) => setServer(i, { name: e.target.value })} placeholder="server name" />
                <button className="icon-btn" onClick={() => removeServer(i)} aria-label="Remove server"><Icon name="close" size={14} /></button>
              </div>
              <input className="mcp-cmd" value={s.command} onChange={(e) => setServer(i, { command: e.target.value })} placeholder="command (e.g. buzz-dev-mcp)" />
              <div className="tool-chips">
                {s.tools.map((t) => (
                  <span className="tool-chip" key={t}>
                    {t}
                    <button onClick={() => removeTool(i, t)} aria-label={`Remove ${t}`}>×</button>
                  </span>
                ))}
                <input
                  className="tool-add"
                  placeholder="+ tool"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      addTool(i, (e.target as HTMLInputElement).value);
                      (e.target as HTMLInputElement).value = "";
                    }
                  }}
                />
              </div>
            </div>
          ))}
          {cfg.mcpServers.length === 0 && <div className="band-empty">No MCP servers — the agent can reason but not act.</div>}
        </div>

        <div className="rd-section">System prompt</div>
        <div className="field">
          <textarea
            style={{ minHeight: 96 }}
            value={cfg.systemPrompt}
            onChange={(e) => set({ systemPrompt: e.target.value })}
          />
        </div>
      </div>

      <div className="rd-foot">
        <span className="muted" style={{ fontSize: 12 }}>{dirty ? "Unsaved changes" : "Saved"}</span>
        <span className="spring" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-brand" disabled={!dirty} onClick={save}>Save changes</button>
      </div>
    </div>
  );
}
