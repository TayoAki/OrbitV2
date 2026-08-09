"use client";
import React from "react";
import { useAppState } from "@/lib/react";
import { Avatar } from "./RunObject";
import { Icon } from "./icons";
import { useUI } from "./ui";

export function Members() {
  const state = useAppState();
  const ui = useUI();
  const all = Object.values(state.members);
  const humans = all.filter((m) => m.kind === "human");
  const agents = all.filter((m) => m.kind === "agent");

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Members</h1>
        <div className="page-sub">People and agents in {state.org.name}</div>
      </div>

      <div className="rd-section" style={{ marginTop: 18 }}>People</div>
      <div className="stack">
        {humans.map((m) => (
          <div className="card" key={m.id}>
            <Avatar member={m} size={38} />
            <div className="grow">
              <div className="ct">{m.name} {m.id === state.currentUserId && <span className="muted" style={{ fontWeight: 400 }}>· you</span>}</div>
              <div className="cs">@{m.handle}</div>
            </div>
            <span className="role-tag">{m.role}</span>
          </div>
        ))}
      </div>

      <div className="rd-section" style={{ marginTop: 24 }}>Agents <span className="muted" style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· click to configure</span></div>
      <div className="stack">
        {agents.map((m) => (
          <div
            className="card clickable"
            key={m.id}
            role="button"
            tabIndex={0}
            onClick={() => ui.openAgent(m.id)}
            onKeyDown={(e) => e.key === "Enter" && ui.openAgent(m.id)}
          >
            <Avatar member={m} size={38} status={m.config?.presence === "online" ? "good" : "idle"} />
            <div className="grow">
              <div className="ct" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                {m.name} <Icon name="robot" size={15} className="muted" />
              </div>
              <div className="cs">@{m.handle} · {m.config?.model} · {m.config?.mcpServers.length ?? 0} MCP server{(m.config?.mcpServers.length ?? 0) === 1 ? "" : "s"}</div>
            </div>
            <span className="role-tag">{m.role}</span>
            <Icon name="chevronRight" size={16} className="muted" />
          </div>
        ))}
      </div>
    </>
  );
}
