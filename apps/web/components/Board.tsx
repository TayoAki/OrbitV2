"use client";
import React from "react";
import Link from "next/link";
import { useAppState } from "@/lib/react";
import { selectBoard } from "@/lib/selectors";
import { useUI } from "./ui";
import { BoardCard } from "./RunObject";
import { Icon } from "./icons";

const SWATCH: Record<string, string> = {
  todo: "var(--faint)",
  building: "var(--brand)",
  review: "var(--info)",
  approve: "var(--warn)",
  blocked: "var(--critical)",
  done: "var(--good)",
};

export function Board() {
  const state = useAppState();
  const ui = useUI();
  const cols = selectBoard(state, { repoId: ui.scopeRepoId });
  const connected = Object.values(state.repos).filter((r) => r.connected);

  return (
    <>
      <div className="page-head-row">
        <div className="page-head">
          <h1 className="page-title">Board</h1>
          <div className="page-sub">Every run by state — plan and monitor at a glance</div>
        </div>
        <button className="btn btn-brand" onClick={() => ui.openNewTask()}>
          <Icon name="plus" size={15} /> New task
        </button>
      </div>

      {connected.length === 0 ? (
        <div className="empty" style={{ marginTop: 22 }}>
          <div className="em-ico"><Icon name="connections" size={30} /></div>
          <h3>No repositories connected</h3>
          <p>Connect a repo to see its runs flow across the board.</p>
          <div className="actions"><Link href="/connections" className="btn btn-brand">Connect a repo</Link></div>
        </div>
      ) : (
        <div className="board" style={{ marginTop: 18 }}>
          {cols.map((col) => (
            <div className="bcol" key={col.key}>
              <div className="bcol-head">
                <span className="swatch" style={{ background: SWATCH[col.key] }} />
                {col.label}
                <span className="count">{col.runs.length}</span>
              </div>
              <div className="bcol-body">
                {col.runs.length === 0 ? (
                  <div className="bcol-empty">—</div>
                ) : (
                  col.runs.map((r) => <BoardCard key={r.id} run={r} onOpen={ui.openRun} />)
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
