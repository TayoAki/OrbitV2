"use client";
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useApp, useAppState } from "@/lib/react";
import { selectInbox } from "@/lib/selectors";
import { Icon, type IconName } from "./icons";
import { UICtx, type UIApi } from "./ui";
import { RunDetail } from "./RunDetail";
import { NewTaskModal } from "./NewTask";
import { Avatar } from "./RunObject";
import { RepoSwitcher } from "./RepoSwitcher";
import { SearchPalette } from "./SearchPalette";
import { AgentEditor } from "./AgentEditor";
import { AddRepoModal } from "./AddRepo";

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const t = (document.documentElement.getAttribute("data-theme") as "light" | "dark") || "light";
    setTheme(t);
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("acme-theme", next);
    } catch {}
    setTheme(next);
  };
  return (
    <button className="theme-toggle" onClick={toggle} aria-label="Toggle theme" title="Toggle theme">
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}

function Toasts() {
  const { toasts, dismissToast } = useApp();
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismissToast(t.id)}>
          <span className="tdot" />
          {t.text}
        </div>
      ))}
    </div>
  );
}

function Splash({ label }: { label: string }) {
  return (
    <div className="splash">
      <span className="rail-logo splash-logo">{label.charAt(0)}</span>
    </div>
  );
}

const NAV: { href: string; label: string; icon: IconName; badge?: boolean }[] = [
  { href: "/inbox", label: "Inbox", icon: "inbox", badge: true },
  { href: "/board", label: "Board", icon: "board" },
  { href: "/threads", label: "Threads", icon: "threads" },
];
const NAV2: { href: string; label: string; icon: IconName }[] = [
  { href: "/members", label: "Members", icon: "members" },
  { href: "/connections", label: "Connections", icon: "connections" },
];
const SWITCH: { href: string; label: string; icon: IconName }[] = [
  { href: "/inbox", label: "Inbox", icon: "inbox" },
  { href: "/board", label: "Board", icon: "board" },
  { href: "/threads", label: "Threads", icon: "threads" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/inbox";
  const state = useAppState();
  const app = useApp();
  const router = useRouter();
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [newTask, setNewTask] = useState<{ open: boolean; repoId?: string }>({ open: false });
  const [scopeRepo, setScopeRepo] = useState<string | null>(
    () => Object.values(state.repos).find((r) => r.connected)?.id ?? null,
  );
  const [agentId, setAgentId] = useState<string | null>(null);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  // Close drawers + the mobile nav when the primary surface changes.
  useEffect(() => {
    setSelectedRun(null);
    setAgentId(null);
    setMobileNav(false);
  }, [pathname]);

  // Global ⌘K / Ctrl-K opens search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auth gate: send users to /login → /onboarding → the console based on session.
  useEffect(() => {
    if (!app.sessionReady) return;
    const authRoute = pathname === "/login" || pathname.startsWith("/onboarding");
    if (!app.session.authed) {
      if (pathname !== "/login") router.replace("/login");
    } else if (!app.session.onboarded) {
      if (pathname !== "/onboarding") router.replace("/onboarding");
    } else if (authRoute) {
      router.replace("/inbox");
    }
  }, [app.sessionReady, app.session.authed, app.session.onboarded, pathname, router]);

  // Overlays are mutually exclusive — opening one dismisses the others so a
  // drawer can never end up buried behind a stale modal.
  const closeOverlays = () => {
    setSelectedRun(null);
    setAgentId(null);
    setNewTask({ open: false });
    setAddRepoOpen(false);
    setSearchOpen(false);
  };

  const ui: UIApi = useMemo(
    () => ({
      openRun: (id) => {
        closeOverlays();
        setSelectedRun(id);
      },
      closeRun: () => setSelectedRun(null),
      openNewTask: (repoId) => {
        closeOverlays();
        setNewTask({ open: true, repoId });
      },
      selectedRunId: selectedRun,
      scopeRepoId: scopeRepo,
      setScopeRepo,
      openAgent: (id) => {
        closeOverlays();
        setAgentId(id);
      },
      openAddRepo: () => {
        closeOverlays();
        setAddRepoOpen(true);
      },
      openSearch: () => {
        closeOverlays();
        setSearchOpen(true);
      },
    }),
    [selectedRun, scopeRepo],
  );

  const needsYou = selectInbox(state).counts.needsYou;
  const me = state.members[state.currentUserId];
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const switchActive = (href: string) => (pathname === "/" ? href === "/inbox" : isActive(href));

  // Gate: splash while the session hydrates; auth screens render without console
  // chrome; splash while a redirect settles so the console never flashes.
  const authRoute = pathname === "/login" || pathname.startsWith("/onboarding");
  if (!app.sessionReady) return <Splash label={state.org.name} />;
  if (authRoute) return <>{children}</>;
  if (!app.session.authed || !app.session.onboarded) return <Splash label={state.org.name} />;

  return (
    <UICtx.Provider value={ui}>
      <div className="app-grid">
        {/* ── Rail (off-canvas drawer on mobile) ───────────────── */}
        {mobileNav && <div className="rail-scrim" onClick={() => setMobileNav(false)} />}
        <aside className={`rail ${mobileNav ? "open" : ""}`}>
          <RepoSwitcher />

          <nav className="nav">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className={`nav-item ${isActive(n.href) ? "active" : ""}`}>
                <span className="ico"><Icon name={n.icon} size={17} /></span>
                <span className="nav-label">{n.label}</span>
                {n.badge && needsYou > 0 && <span className="nav-badge">{needsYou}</span>}
              </Link>
            ))}
          </nav>

          <div className="rail-divider" />
          <div className="rail-caption">Workspace</div>
          <nav className="nav" style={{ marginTop: 0 }}>
            {NAV2.map((n) => (
              <Link key={n.href} href={n.href} className={`nav-item ${isActive(n.href) ? "active" : ""}`}>
                <span className="ico"><Icon name={n.icon} size={17} /></span>
                <span className="nav-label">{n.label}</span>
              </Link>
            ))}
          </nav>

          <div className="rail-spacer" />
          <div className="rail-foot">
            <details className="user-menu">
              <summary className="user-chip">
                {me && <Avatar member={me} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="name">{me?.name}</div>
                  <div className="handle">@{me?.handle}</div>
                </div>
                <Icon name="chevronDown" size={14} className="chev" />
              </summary>
              <div className="user-pop">
                <button onClick={() => app.restartOnboarding()}><Icon name="connections" size={14} /> Restart onboarding</button>
                <button className="danger" onClick={() => app.logout()}><Icon name="external" size={14} /> Log out</button>
              </div>
            </details>
            <ThemeToggle />
          </div>
        </aside>

        {/* ── Main ─────────────────────────────────────────────── */}
        <div className="main">
          <header className="topbar">
            <button className="rail-toggle" onClick={() => setMobileNav(true)} aria-label="Open menu">
              <Icon name="menu" size={18} />
            </button>
            <nav className="switcher" aria-label="Primary views">
              {SWITCH.map((s) => (
                <Link key={s.href} href={s.href} className={`switch-tab ${switchActive(s.href) ? "active" : ""}`}>
                  <Icon name={s.icon} size={15} />
                  <span className="switch-label">{s.label}</span>
                </Link>
              ))}
            </nav>
            <div className="top-actions">
              <button className="kbd-search" title="Search" onClick={ui.openSearch}>
                <Icon name="search" size={15} />
                <kbd>⌘K</kbd>
              </button>
              <Link href="/connections" className="icon-btn" title="Settings">
                <Icon name="gear" size={18} />
              </Link>
            </div>
          </header>

          <main className="content">
            <div className={`content-wrap${pathname.startsWith("/threads") ? " wrap-wide" : ""}`}>{children}</div>
          </main>
        </div>

        {/* ── Drawer (state-driven run detail) ─────────────────── */}
        {selectedRun && state.runs[selectedRun] && (
          <>
            <div className="scrim" onClick={ui.closeRun} />
            <aside className="drawer" role="dialog" aria-label="Run detail">
              <RunDetail runId={selectedRun} variant="drawer" onClose={ui.closeRun} />
            </aside>
          </>
        )}

        {/* ── Agent editor drawer ─────────────────────────────── */}
        {agentId && state.members[agentId] && (
          <>
            <div className="scrim" onClick={() => setAgentId(null)} />
            <aside className="drawer" role="dialog" aria-label="Agent editor">
              <AgentEditor key={agentId} memberId={agentId} onClose={() => setAgentId(null)} />
            </aside>
          </>
        )}

        {newTask.open && <NewTaskModal repoId={newTask.repoId} onClose={() => setNewTask({ open: false })} />}
        {addRepoOpen && <AddRepoModal onClose={() => setAddRepoOpen(false)} />}
        {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
        <Toasts />
      </div>
    </UICtx.Provider>
  );
}
