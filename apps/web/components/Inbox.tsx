"use client";
import React, { useState } from "react";
import Link from "next/link";
import { useAppState } from "@/lib/react";
import { selectInbox } from "@/lib/selectors";
import type { RunState } from "@/lib/types";
import { useUI } from "./ui";
import { RunRow } from "./RunObject";
import { Icon } from "./icons";

function Band({
  lead,
  title,
  tone,
  children,
}: {
  lead: string;
  title: string;
  tone?: "brand" | "crit" | "muted";
  children: React.ReactNode;
}) {
  const cls = tone === "crit" ? "crit" : tone === "muted" ? "muted" : "";
  return (
    <section className="band">
      <div className={`band-label ${cls}`}>
        <span className="lead">{lead}</span>
        {title}
      </div>
      {children}
    </section>
  );
}

function RowList({ runs, selected, onOpen }: { runs: RunState[]; selected: string | null; onOpen: (id: string) => void }) {
  return (
    <div className="rows">
      {runs.map((r) => (
        <RunRow key={r.id} run={r} onOpen={onOpen} selected={selected === r.id} />
      ))}
    </div>
  );
}

export function Inbox() {
  const state = useAppState();
  const ui = useUI();
  const [mineOnly, setMineOnly] = useState(false);
  const [needsOnly, setNeedsOnly] = useState(false);
  const repoId = ui.scopeRepoId; // driven by the top-left repo switcher

  const connectedRepos = Object.values(state.repos).filter((r) => r.connected);
  const inbox = selectInbox(state, { mineOnly, repoId });
  const { readyToApprove, blocked } = inbox.needsYou;
  const total = inbox.counts.needsYou + inbox.counts.inFlight + inbox.counts.shipped;
  const sel = ui.selectedRunId;

  const activeRepo = repoId ? state.repos[repoId] : null;

  const head = (
    <div className="page-head-row">
      <div className="page-head">
        <h1 className="page-title">Inbox</h1>
        <div className="page-sub">What needs you right now</div>
      </div>
      <button className="btn btn-brand" onClick={() => ui.openNewTask(repoId ?? undefined)}>
        <Icon name="plus" size={15} /> New task
      </button>
    </div>
  );

  if (connectedRepos.length === 0) {
    return (
      <>
        {head}
        <div className="empty" style={{ marginTop: 22 }}>
          <div className="em-ico"><Icon name="connections" size={30} /></div>
          <h3>Connect a repository to get started</h3>
          <p>Once a repo is connected, its open agent runs land here — ready to review, approve, and merge.</p>
          <div className="actions">
            <Link href="/connections" className="btn btn-brand">Connect a repo</Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {head}

      <div className="filter-bar" style={{ marginTop: 18 }}>
        <button className={`fpill ${mineOnly ? "on" : ""}`} onClick={() => setMineOnly((v) => !v)}>
          <Icon name="person" size={14} className="ico" /> My runs
        </button>
        <button className={`fpill ${needsOnly ? "on" : ""}`} onClick={() => setNeedsOnly((v) => !v)}>
          <span className="dot" /> Needs you
        </button>
        <details className="fpill-wrap">
          <summary className="fpill">
            <Icon name="repo" size={14} className="ico" />
            {activeRepo ? activeRepo.slug.split("/").pop() : "All repos"}
            <Icon name="chevronDown" size={13} className="chev" />
          </summary>
          <div className="fmenu">
            <button className={!repoId ? "sel" : ""} onClick={() => ui.setScopeRepo(null)}>All repos</button>
            {connectedRepos.map((r) => (
              <button key={r.id} className={repoId === r.id ? "sel" : ""} onClick={() => ui.setScopeRepo(r.id)}>
                {r.slug}
              </button>
            ))}
          </div>
        </details>
        <span className="filter-spring" />
        <button className="fpill">
          <Icon name="sort" size={14} className="ico" /> Sort: oldest first
        </button>
      </div>

      {total === 0 ? (
        <div className="empty">
          <div className="em-ico"><Icon name="checkCircle" size={30} /></div>
          <h3>You&rsquo;re all caught up</h3>
          <p>No runs match this filter. Start a task and the agent&rsquo;s work will show up here as it happens.</p>
        </div>
      ) : (
        <>
          <Band lead="A" title="Needs you" tone="brand">
            {readyToApprove.length === 0 && blocked.length === 0 && (
              <div className="band-empty">Nothing needs you right now.</div>
            )}
            {readyToApprove.length > 0 && (
              <>
                <div className="subhead">Ready to approve <span className="count">{readyToApprove.length}</span></div>
                <RowList runs={readyToApprove} selected={sel} onOpen={ui.openRun} />
              </>
            )}
            {blocked.length > 0 && (
              <>
                <div className="subhead">Blocked <span className="count">{blocked.length}</span></div>
                <RowList runs={blocked} selected={sel} onOpen={ui.openRun} />
              </>
            )}
          </Band>

          {!needsOnly && (
            <Band lead="B" title="In flight" tone="muted">
              {inbox.inFlight.length === 0 ? (
                <div className="band-empty">No runs in flight.</div>
              ) : (
                <RowList runs={inbox.inFlight} selected={sel} onOpen={ui.openRun} />
              )}
            </Band>
          )}

          {!needsOnly && inbox.recentlyShipped.length > 0 && (
            <Band lead="C" title="Recently shipped" tone="muted">
              <RowList runs={inbox.recentlyShipped} selected={sel} onOpen={ui.openRun} />
            </Band>
          )}
        </>
      )}
    </>
  );
}
