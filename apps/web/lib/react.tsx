"use client";
// ─────────────────────────────────────────────────────────────────────────────
// React binding: one store via useSyncExternalStore, plus the action surface
// (start task / approve / request changes / continue / abort / connect repo) and
// a tiny toast queue. Components read state through useAppState() and never hold
// their own copy of a run.
// ─────────────────────────────────────────────────────────────────────────────
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createStore, type Store } from "./store";
import { SimEngine } from "./sim";
import type { StoreState, AgentConfig } from "./types";

export type ToastTone = "good" | "warn" | "info" | "critical";
export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

export interface AppApi {
  toasts: Toast[];
  toast: (text: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
  startTask: (a: { repoId: string; title: string; acceptanceCriteria?: string; agentId?: string }) => string;
  approve: (runId: string) => void;
  requestChanges: (runId: string, note?: string) => void;
  continueRun: (runId: string) => void;
  abortRun: (runId: string) => void;
  connectRepo: (repoId: string) => void;
  addRepo: (input: { slug: string; defaultBranch?: string; agentId?: string }) => string;
  updateAgent: (memberId: string, config: AgentConfig) => void;
  postMessage: (channelId: string, text: string, scopeRepoId?: string | null) => void;
  // Auth / onboarding session (persisted to localStorage; store data is not).
  session: Session;
  sessionReady: boolean;
  login: (method: string) => void;
  logout: () => void;
  restartOnboarding: () => void;
  completeOnboarding: (data: OnboardingData) => void;
}

export interface Session {
  authed: boolean;
  onboarded: boolean;
}

export interface OnboardingData {
  orgName?: string;
  userName?: string;
  repoIds?: string[];
  agent?: { model: string; autonomy: "supervised" | "autonomous" };
}

const StateCtx = createContext<Store | null>(null);
const AppCtx = createContext<AppApi | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [bundle] = useState(() => {
    const store = createStore();
    return { store, engine: new SimEngine(store) };
  });
  const { store, engine } = bundle;

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  // Session starts logged-out (matches SSR); hydrate from localStorage after mount.
  const [session, setSession] = useState<Session>({ authed: false, onboarded: false });
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("acme-session");
      if (raw) setSession(JSON.parse(raw));
    } catch {}
    setSessionReady(true);
  }, []);

  const persistSession = useCallback((s: Session) => {
    setSession(s);
    try {
      localStorage.setItem("acme-session", JSON.stringify(s));
    } catch {}
  }, []);

  useEffect(() => {
    engine.start();
    return () => engine.stop();
  }, [engine]);

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback(
    (text: string, tone: ToastTone = "info") => {
      toastId.current += 1;
      const id = toastId.current;
      setToasts((t) => [...t, { id, text, tone }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3400);
    },
    [],
  );

  const api = useMemo<AppApi>(
    () => ({
      toasts,
      toast,
      dismissToast,
      startTask: (a) => {
        const id = engine.startTask(a);
        const slug = store.getSnapshot().repos[a.repoId]?.slug ?? "repo";
        toast(`Task started in ${slug}`, "info");
        return id;
      },
      approve: (runId) => {
        engine.approve(runId);
        toast("Approving & merging…", "good");
      },
      requestChanges: (runId, note) => {
        engine.requestChanges(runId, note);
        toast("Changes requested — sent back to the agent", "warn");
      },
      continueRun: (runId) => {
        engine.continueRun(runId);
        toast("Continuing with your hint", "info");
      },
      abortRun: (runId) => {
        engine.abortRun(runId);
        toast("Run aborted — branch & PR kept", "critical");
      },
      connectRepo: (repoId) => {
        engine.connectRepo(repoId);
        const slug = store.getSnapshot().repos[repoId]?.slug ?? "repo";
        toast(`Connected ${slug}`, "good");
      },
      addRepo: (input) => {
        const id = engine.addRepo(input);
        toast(`Added ${input.slug}`, "good");
        return id;
      },
      updateAgent: (memberId, config) => {
        engine.updateAgent(memberId, config);
        const name = store.getSnapshot().members[memberId]?.name ?? "Agent";
        toast(`${name} updated`, "good");
      },
      postMessage: (channelId, text, scopeRepoId) => {
        engine.postMessage(channelId, text, scopeRepoId ?? null);
      },
      session,
      sessionReady,
      login: () => persistSession({ authed: true, onboarded: session.onboarded }),
      logout: () => persistSession({ authed: false, onboarded: session.onboarded }),
      restartOnboarding: () => persistSession({ authed: true, onboarded: false }),
      completeOnboarding: (data) => {
        if (data.orgName || data.userName) engine.updateOrg(data.orgName, data.userName);
        (data.repoIds ?? []).forEach((id) => engine.connectRepo(id));
        if (data.agent) {
          const ship = store.getSnapshot().members["agt_ship"];
          if (ship?.config) engine.updateAgent("agt_ship", { ...ship.config, model: data.agent.model, autonomy: data.agent.autonomy });
        }
        persistSession({ authed: true, onboarded: true });
      },
    }),
    [toasts, toast, dismissToast, engine, store, session, sessionReady, persistSession],
  );

  return (
    <StateCtx.Provider value={store}>
      <AppCtx.Provider value={api}>{children}</AppCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useAppState(): StoreState {
  const store = useContext(StateCtx);
  if (!store) throw new Error("useAppState must be used inside <StoreProvider>");
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useApp(): AppApi {
  const api = useContext(AppCtx);
  if (!api) throw new Error("useApp must be used inside <StoreProvider>");
  return api;
}
