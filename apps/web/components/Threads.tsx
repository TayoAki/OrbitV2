"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useApp, useAppState } from "@/lib/react";
import type { Member, Message, StoreState } from "@/lib/types";
import { ageLabel } from "@/lib/labels";
import { Icon } from "./icons";
import { Avatar, StateChip } from "./RunObject";
import { useUI } from "./ui";

function renderText(text: string, members: Record<string, Member>) {
  const known = new Set(Object.values(members).map((m) => m.handle.toLowerCase()));
  const out: React.ReactNode[] = [];
  const re = /(?<![A-Za-z0-9_])@([a-z0-9_-]+)/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (!known.has(m[1].toLowerCase())) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span className="mention" key={k++}>@{m[1]}</span>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function RunMessage({ runId, onOpen }: { runId: string; onOpen: (id: string) => void }) {
  const state = useAppState();
  const run = state.runs[runId];
  if (!run) return null;
  return (
    <button className="msg-run" onClick={() => onOpen(runId)}>
      <span className="mr-ico"><Icon name="pr" size={15} /></span>
      <span className="mr-main">
        <span className="mr-title">{run.title}</span>
        <span className="mr-sub">{run.prNumber ? `#${run.prNumber} · ` : ""}{run.repoSlug}</span>
      </span>
      <StateChip run={run} />
    </button>
  );
}

function ChannelList({
  channels,
  activeId,
  onPick,
  members,
  currentUserId,
}: {
  channels: StoreState["channels"];
  activeId: string;
  onPick: (id: string) => void;
  members: Record<string, Member>;
  currentUserId: string;
}) {
  const chans = channels.filter((c) => c.kind === "channel");
  const dms = channels.filter((c) => c.kind === "dm");
  return (
    <aside className="ch-list">
      <div className="ch-cap">Channels</div>
      {chans.map((c) => (
        <button key={c.id} className={`ch-item ${c.id === activeId ? "active" : ""}`} onClick={() => onPick(c.id)}>
          <span className="ch-hash">#</span>
          <span className="ch-name">{c.name}</span>
        </button>
      ))}
      <div className="ch-cap" style={{ marginTop: 12 }}>Direct messages</div>
      {dms.map((c) => {
        const agentId = c.memberIds.find((id) => id !== currentUserId);
        const agent = agentId ? members[agentId] : undefined;
        const online = agent?.config?.presence === "online";
        return (
          <button key={c.id} className={`ch-item ${c.id === activeId ? "active" : ""}`} onClick={() => onPick(c.id)}>
            {agent && <Avatar member={agent} size={20} />}
            <span className="ch-name">{c.name}</span>
            <span className={`presence ${online ? "on" : ""}`} />
          </button>
        );
      })}
    </aside>
  );
}

export function Threads() {
  const state = useAppState();
  const app = useApp();
  const ui = useUI();
  const [activeId, setActiveId] = useState("ch_eng");
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const channel = state.channels.find((c) => c.id === activeId) ?? state.channels[0];
  const messages = useMemo(() => state.messages[channel.id] ?? [], [state.messages, channel.id]);
  const agents = Object.values(state.members).filter((m) => m.kind === "agent");

  // New messages: only auto-scroll if the user is already near the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Switching channels: clear the draft (drafts are per-channel) and jump to newest.
  useEffect(() => {
    setText("");
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
  }, [activeId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const dmAgent =
    channel.kind === "dm"
      ? state.members[channel.memberIds.find((id) => id !== state.currentUserId) ?? ""]
      : undefined;

  const send = () => {
    const t = text.trim();
    if (!t) return;
    app.postMessage(channel.id, t, ui.scopeRepoId);
    setText("");
  };

  const insertMention = (handle: string) => {
    setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${handle} `);
  };

  const scopeRepo = ui.scopeRepoId ? state.repos[ui.scopeRepoId] : null;

  return (
    <div className="threads">
      <ChannelList
        channels={state.channels}
        activeId={channel.id}
        onPick={setActiveId}
        members={state.members}
        currentUserId={state.currentUserId}
      />

      <section className="ch-main">
        <header className="ch-head">
          {channel.kind === "dm" && dmAgent ? (
            <>
              <Avatar member={dmAgent} size={26} status={dmAgent.config?.presence === "online" ? "good" : "idle"} />
              <div>
                <div className="ch-title">{dmAgent.name}</div>
                <div className="ch-topic">@{dmAgent.handle} · {dmAgent.config?.model}</div>
              </div>
            </>
          ) : (
            <>
              <span className="ch-hash big">#</span>
              <div>
                <div className="ch-title">{channel.name}</div>
                <div className="ch-topic">{channel.topic}</div>
              </div>
            </>
          )}
        </header>

        <div className="msg-scroll" ref={scrollRef} onScroll={onScroll}>
          {messages.map((msg: Message) => {
            const author = state.members[msg.authorId];
            if (msg.kind === "system") {
              return <div className="msg-system" key={msg.id}>{msg.text}</div>;
            }
            return (
              <div className="msg" key={msg.id}>
                {author && <Avatar member={author} size={34} />}
                <div className="msg-body">
                  <div className="msg-head">
                    <span className="msg-author">{author?.name ?? "Unknown"}</span>
                    {author?.kind === "agent" && <span className="agent-tag">agent</span>}
                    <span className="msg-time">{msg.at === 0 ? "just now" : `${ageLabel(msg.at)} ago`}</span>
                  </div>
                  <div className="msg-text">{renderText(msg.text, state.members)}</div>
                  {msg.kind === "run" && msg.runId && <RunMessage runId={msg.runId} onOpen={ui.openRun} />}
                </div>
              </div>
            );
          })}
        </div>

        <div className="composer-bar">
          <div className="mention-row">
            <span className="muted" style={{ fontSize: 12 }}>Mention:</span>
            {agents.map((a) => (
              <button key={a.id} className="mention-chip" onClick={() => insertMention(a.handle)}>@{a.handle}</button>
            ))}
            <span className="spring" />
            <span className="muted" style={{ fontSize: 11.5 }}>
              {scopeRepo ? `runs → ${scopeRepo.slug}` : "pick a repo to run in"}
            </span>
          </div>
          <div className="composer-input">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                channel.kind === "dm"
                  ? `Message ${dmAgent?.name}…  (it replies and can start a run)`
                  : `Message #${channel.name}…  @mention an agent to start a run`
              }
              rows={1}
            />
            <button className="btn btn-brand" onClick={send} disabled={!text.trim()}>
              <Icon name="arrowRight" size={15} /> Send
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
