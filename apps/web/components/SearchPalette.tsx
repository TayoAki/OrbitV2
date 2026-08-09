"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp, useAppState } from "@/lib/react";
import { CHIP_LABEL } from "@/lib/labels";
import type { IconName } from "./icons";
import { Icon } from "./icons";
import { useUI } from "./ui";

type Item =
  | { kind: "run"; id: string; title: string; sub: string; icon: IconName }
  | { kind: "agent"; id: string; title: string; sub: string; icon: IconName }
  | { kind: "repo"; id: string; title: string; sub: string; icon: IconName }
  | { kind: "nav"; href: string; title: string; sub: string; icon: IconName };

const NAV: { href: string; title: string; icon: IconName }[] = [
  { href: "/inbox", title: "Inbox", icon: "inbox" },
  { href: "/board", title: "Board", icon: "board" },
  { href: "/threads", title: "Threads", icon: "threads" },
  { href: "/members", title: "Members", icon: "members" },
  { href: "/connections", title: "Connections", icon: "connections" },
];

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const app = useApp();
  const ui = useUI();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const match = (...s: (string | undefined)[]) => s.some((x) => x && x.toLowerCase().includes(query));

    const runs = Object.values(state.runs)
      .filter((r) => {
        const agent = state.members[r.agentId];
        return !query || match(r.title, r.repoSlug, agent?.handle, r.prNumber ? `#${r.prNumber}` : undefined, r.headSha);
      })
      .slice(0, 6)
      .map<Item>((r) => ({
        kind: "run",
        id: r.id,
        title: r.title,
        sub: `${r.prNumber ? `#${r.prNumber} · ` : ""}${r.repoSlug} · ${CHIP_LABEL[r.runState].toLowerCase()}`,
        icon: "pr",
      }));

    const agents = Object.values(state.members)
      .filter((m) => m.kind === "agent" && (!query || match(m.name, m.handle, m.role)))
      .map<Item>((m) => ({ kind: "agent", id: m.id, title: m.name, sub: `@${m.handle} · edit agent`, icon: "robot" }));

    const repos = Object.values(state.repos)
      .filter((r) => !query || match(r.slug))
      .map<Item>((r) => ({ kind: "repo", id: r.id, title: r.slug, sub: r.connected ? "switch to repo" : "connect & switch", icon: "repo" }));

    const nav = NAV.filter((n) => !query || match(n.title)).map<Item>((n) => ({
      kind: "nav",
      href: n.href,
      title: n.title,
      sub: "go to",
      icon: n.icon,
    }));

    return [...runs, ...agents, ...repos, ...nav];
  }, [q, state]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  const select = (it: Item) => {
    onClose();
    if (it.kind === "run") ui.openRun(it.id);
    else if (it.kind === "agent") ui.openAgent(it.id);
    else if (it.kind === "repo") {
      const repo = state.repos[it.id];
      if (repo && !repo.connected) app.connectRepo(it.id); // label promises "connect & switch"
      ui.setScopeRepo(it.id);
      router.push("/inbox");
    } else router.push(it.href);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[active]) select(items[active]);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  const groupLabel: Record<Item["kind"], string> = { run: "Runs", agent: "Agents", repo: "Repositories", nav: "Go to" };
  let lastKind: string | null = null;

  return (
    <div className="cmd-scrim" onClick={onClose}>
      <div className="cmd" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Search">
        <div className="cmd-input">
          <Icon name="search" size={17} className="muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search runs, agents, repos, or jump to a page…"
          />
          <kbd>esc</kbd>
        </div>
        <div className="cmd-results">
          {items.length === 0 && <div className="cmd-empty">No matches for “{q}”.</div>}
          {items.map((it, i) => {
            const head = it.kind !== lastKind ? ((lastKind = it.kind), groupLabel[it.kind]) : null;
            return (
              <React.Fragment key={`${it.kind}-${"id" in it ? it.id : it.href}`}>
                {head && <div className="cmd-group">{head}</div>}
                <button
                  className={`cmd-item ${i === active ? "active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => select(it)}
                >
                  <span className="cmd-ico"><Icon name={it.icon} size={16} /></span>
                  <span className="cmd-title">{it.title}</span>
                  <span className="cmd-sub">{it.sub}</span>
                  <Icon name="arrowRight" size={14} className="cmd-go" />
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
