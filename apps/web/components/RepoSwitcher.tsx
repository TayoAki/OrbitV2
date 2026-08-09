"use client";
import React, { useEffect, useRef } from "react";
import Link from "next/link";
import { useApp, useAppState } from "@/lib/react";
import { Icon } from "./icons";
import { useUI } from "./ui";

// The top-left switcher: shows the repository the app is scoped to, with a
// dropdown to switch between connected repos, jump to "All repositories", or
// connect a disconnected one in place.
export function RepoSwitcher() {
  const state = useAppState();
  const app = useApp();
  const ui = useUI();
  const ref = useRef<HTMLDetailsElement>(null);

  const repos = Object.values(state.repos);
  const connected = repos.filter((r) => r.connected);
  const disconnected = repos.filter((r) => !r.connected);
  const scoped = ui.scopeRepoId ? state.repos[ui.scopeRepoId] : null;

  // Close on outside click / Escape (native <details> doesn't do this itself).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onDown = (e: MouseEvent) => {
      if (el.open && !el.contains(e.target as Node)) el.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") el.open = false;
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const close = () => {
    if (ref.current) ref.current.open = false;
  };
  const pick = (id: string | null) => {
    ui.setScopeRepo(id);
    close();
  };
  const connectAndPick = (id: string) => {
    app.connectRepo(id);
    ui.setScopeRepo(id);
    close();
  };

  const shortName = scoped ? scoped.slug.split("/").pop()! : null;
  const label = scoped ? scoped.slug : "All repositories";

  return (
    <details className="org-switcher-wrap" ref={ref}>
      <summary className="org-switcher" title="Switch repository">
        <span className="rail-logo">
          {shortName ? shortName.charAt(0).toUpperCase() : <Icon name="repo" size={15} />}
        </span>
        <span className="org-name">{label}</span>
        <Icon name="chevronDown" className="chev" size={15} />
      </summary>

      <div className="repo-menu">
        <div className="cap">{state.org.name} · repositories</div>

        <button className={`repo-item ${ui.scopeRepoId === null ? "sel" : ""}`} onClick={() => pick(null)}>
          <span className="rl"><Icon name="board" size={15} /></span>
          <span className="rt">All repositories</span>
          {ui.scopeRepoId === null && <Icon name="check" size={15} className="ck" />}
        </button>

        {connected.map((r) => (
          <button key={r.id} className={`repo-item ${ui.scopeRepoId === r.id ? "sel" : ""}`} onClick={() => pick(r.id)}>
            <span className="dot good" />
            <span className="rt">{r.slug}</span>
            {ui.scopeRepoId === r.id && <Icon name="check" size={15} className="ck" />}
          </button>
        ))}

        {disconnected.length > 0 && <div className="repo-sep" />}
        {disconnected.map((r) => (
          <button key={r.id} className="repo-item" onClick={() => connectAndPick(r.id)}>
            <span className="dot idle" />
            <span className="rt muted">{r.slug}</span>
            <span className="repo-badge">Connect</span>
          </button>
        ))}

        <div className="repo-sep" />
        <button className="repo-item" onClick={() => { close(); ui.openAddRepo(); }}>
          <span className="rl"><Icon name="plus" size={15} /></span>
          <span className="rt">Add repository…</span>
        </button>
        <Link href="/connections" className="repo-item" onClick={close}>
          <span className="rl"><Icon name="connections" size={15} /></span>
          <span className="rt">Manage connections</span>
        </Link>
      </div>
    </details>
  );
}
