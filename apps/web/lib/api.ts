// ─────────────────────────────────────────────────────────────────────────────
// Typed client for the Shipbot control plane (apps/api). This is the live-data
// seam: today the UI renders from the in-memory sim engine; pointing it at a real
// backend is a matter of feeding these calls + the SSE stream into the store.
// Set NEXT_PUBLIC_API_URL to the deployed control-plane origin to enable it.
// ─────────────────────────────────────────────────────────────────────────────
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
export const isLiveBackend = API_BASE.length > 0;

/** Backend Run shape (mirrors apps/api domain.ts Run). */
export interface BackendRun {
  id: string;
  workspaceId: string;
  repositoryId: string;
  title: string;
  instructions: string;
  state: string;
  attentionReason: string | null;
  stateVersion: number;
  branchName: string | null;
  headSha: string | null;
  prNumber: number | null;
  gateHash: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BackendEvent {
  id: string;
  runId: string;
  sequence: number;
  eventType: string;
  source: string;
  headSha: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PublicConnector {
  provider: "linear" | "coderabbit" | "greptile";
  displayName: string;
  category: string;
  needsGithubToken: boolean;
  status: "connected" | "error" | "not_configured";
  accountLabel: string | null;
  detail: string | null;
  lastValidatedAt: string | null;
}
export interface ConnectorValidation {
  ok: boolean;
  status: number;
  account?: string;
  detail: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (!isLiveBackend) throw new Error("NEXT_PUBLIC_API_URL is not set");
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string })?.error ?? res.statusText, body);
  return body;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export const api = {
  health: () => req<{ ok: boolean }>("/healthz"),
  listRuns: (repositoryId?: string) =>
    req<{ runs: BackendRun[] }>(`/v1/runs${repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : ""}`),
  inbox: (workspaceId?: string) =>
    req<{ runs: BackendRun[] }>(`/v1/inbox${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`),
  getRun: (id: string) => req<{ run: BackendRun; events: BackendEvent[] }>(`/v1/runs/${encodeURIComponent(id)}`),
  createRun: (input: {
    workspaceId: string;
    repositoryId: string;
    creatorUserId: string;
    title: string;
    instructions: string;
    acceptanceCriteria?: { criteria: string[]; browserRequired: boolean };
    executionMode?: "SUPERVISED" | "AUTONOMOUS";
  }) => req<BackendRun>("/v1/runs", { method: "POST", body: JSON.stringify(input) }),
  approve: (id: string, approverUserId: string, approverGithubUserId: number) =>
    req<{ ok: boolean; reason?: string }>(`/v1/runs/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ approverUserId, approverGithubUserId }),
    }),
  cancel: (id: string, userId: string) =>
    req<{ cancelled: boolean }>(`/v1/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  // ── connectors (Linear / CodeRabbit / Greptile) ───────────────────────────
  listConnectors: (workspaceId: string) =>
    req<{ connectors: PublicConnector[] }>(`/v1/connectors?workspaceId=${encodeURIComponent(workspaceId)}`),
  connectConnector: (provider: string, workspaceId: string, apiKey: string, githubToken?: string) =>
    req<ConnectorValidation>(`/v1/connectors/${encodeURIComponent(provider)}`, {
      method: "POST",
      body: JSON.stringify({ workspaceId, apiKey, githubToken }),
    }),
  testConnector: (provider: string, workspaceId: string) =>
    req<ConnectorValidation>(`/v1/connectors/${encodeURIComponent(provider)}/test`, {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    }),
  disconnectConnector: (provider: string, workspaceId: string) =>
    req<{ disconnected: boolean }>(`/v1/connectors/${encodeURIComponent(provider)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: "DELETE",
    }),
  linearIssues: (workspaceId: string) =>
    req<{ issues: { id: string; identifier: string; title: string; state: string }[] }>(
      `/v1/connectors/linear/issues?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),

  /** Tail a run's event log over SSE. Returns an unsubscribe function. */
  streamRunEvents(id: string, onEvent: (e: BackendEvent) => void): () => void {
    if (!isLiveBackend) return () => {};
    const es = new EventSource(`${API_BASE}/v1/runs/${encodeURIComponent(id)}/events`);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as BackendEvent);
      } catch {
        /* keep-alive / non-JSON frame */
      }
    };
    return () => es.close();
  },
};
