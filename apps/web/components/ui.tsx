"use client";
import { createContext, useContext } from "react";

export interface UIApi {
  /** Open a run in the side drawer (state-driven — the full page lives at /runs/[id]). */
  openRun: (id: string) => void;
  closeRun: () => void;
  openNewTask: (repoId?: string) => void;
  selectedRunId: string | null;
  /** The repo the whole app is scoped to (null = all connected repos). */
  scopeRepoId: string | null;
  setScopeRepo: (id: string | null) => void;
  /** Open the agent editor drawer for a given agent member id. */
  openAgent: (id: string) => void;
  /** Open the "add repository" modal. */
  openAddRepo: () => void;
  /** Open the ⌘K search palette. */
  openSearch: () => void;
}

export const UICtx = createContext<UIApi | null>(null);

export function useUI(): UIApi {
  const c = useContext(UICtx);
  if (!c) throw new Error("useUI must be used inside the Shell");
  return c;
}
