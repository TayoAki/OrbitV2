// ─────────────────────────────────────────────────────────────────────────────
// Connectors — REAL, live integrations to Linear, CodeRabbit, and Greptile. These
// make authenticated HTTP calls to the providers' actual APIs (verified against
// their docs + live 401 probes). Credentials live ONLY here in the control plane,
// encrypted at rest; they never reach the frontend or the executor.
//
// Endpoints/auth (confirmed live 2026-08):
//   • Linear     POST https://api.linear.app/graphql   Authorization: <api-key>
//   • CodeRabbit POST https://api.coderabbit.ai/api/v1/report.generate  x-coderabbitai-api-key: <key>
//   • Greptile   GET  https://api.greptile.com/v2/repositories/<id>  Authorization: Bearer <key> + X-GitHub-Token
// ─────────────────────────────────────────────────────────────────────────────

import type { ConnectorName } from "./domain";
export type { ConnectorName };

export interface ConnectorCredential {
  apiKey: string;
  /** Greptile needs a GitHub token in addition to its API key. */
  githubToken?: string;
}

export interface ValidationResult {
  ok: boolean;
  /** Upstream HTTP status (0 = network error). */
  status: number;
  /** Human-readable account/org label when ok. */
  account?: string;
  detail: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  state: string;
}

export interface Connector {
  readonly name: ConnectorName;
  readonly displayName: string;
  readonly category: string;
  readonly needsGithubToken: boolean;
  /** Make a real authenticated call; classify the credential. */
  validate(cred: ConnectorCredential): Promise<ValidationResult>;
}

const TIMEOUT_MS = 12_000;
async function call(url: string, init: RequestInit): Promise<{ status: number; text: string; json: unknown }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(t);
  }
}

// ── Linear (GraphQL) ─────────────────────────────────────────────────────────
export class LinearConnector implements Connector {
  readonly name = "linear" as const;
  readonly displayName = "Linear";
  readonly category = "issue-tracker";
  readonly needsGithubToken = false;

  async validate(cred: ConnectorCredential): Promise<ValidationResult> {
    try {
      const { status, json } = await call("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: cred.apiKey },
        body: JSON.stringify({ query: "{ viewer { id name email organization { name } } }" }),
      });
      const viewer = (json as { data?: { viewer?: { name?: string; organization?: { name?: string } } } })?.data?.viewer;
      if (status === 200 && viewer) {
        const org = viewer.organization?.name;
        return { ok: true, status, account: org ? `${viewer.name} · ${org}` : String(viewer.name), detail: "Authenticated with Linear" };
      }
      const msg = (json as { errors?: { message?: string }[] })?.errors?.[0]?.message ?? `HTTP ${status}`;
      return { ok: false, status, detail: msg };
    } catch (e) {
      return { ok: false, status: 0, detail: `network error: ${(e as Error).message}` };
    }
  }

  async listIssues(cred: ConnectorCredential, first = 20): Promise<LinearIssue[]> {
    const { status, json } = await call("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: cred.apiKey },
      body: JSON.stringify({
        query: `{ issues(first: ${first}, orderBy: updatedAt) { nodes { id identifier title state { name } } } }`,
      }),
    });
    if (status !== 200) throw new Error(`Linear issues HTTP ${status}`);
    const nodes = (json as { data?: { issues?: { nodes?: { id: string; identifier: string; title: string; state?: { name?: string } }[] } } })?.data?.issues?.nodes ?? [];
    return nodes.map((n) => ({ id: n.id, identifier: n.identifier, title: n.title, state: n.state?.name ?? "" }));
  }
}

// ── CodeRabbit (report API — auth probe) ─────────────────────────────────────
export class CodeRabbitConnector implements Connector {
  readonly name = "coderabbit" as const;
  readonly displayName = "CodeRabbit";
  readonly category = "code-review";
  readonly needsGithubToken = false;

  async validate(cred: ConnectorCredential): Promise<ValidationResult> {
    try {
      // Empty body: an accepted key returns a 4xx validation error; a bad key returns
      // 401. We classify on auth, not on a generated report (no side effect / cost).
      const { status } = await call("https://api.coderabbit.ai/api/v1/report.generate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-coderabbitai-api-key": cred.apiKey },
        body: JSON.stringify({}),
      });
      if (status === 401 || status === 403) return { ok: false, status, detail: "Invalid CodeRabbit API key" };
      return { ok: true, status, account: "CodeRabbit", detail: status === 200 ? "Connected" : `Key accepted (probe → HTTP ${status})` };
    } catch (e) {
      return { ok: false, status: 0, detail: `network error: ${(e as Error).message}` };
    }
  }
}

// ── Greptile (v2 — auth probe on repositories) ───────────────────────────────
export class GreptileConnector implements Connector {
  readonly name = "greptile" as const;
  readonly displayName = "Greptile";
  readonly category = "code-context";
  readonly needsGithubToken = true;

  async validate(cred: ConnectorCredential): Promise<ValidationResult> {
    try {
      const probeId = encodeURIComponent("github:main:orbit/connection-probe");
      const { status, text } = await call(`https://api.greptile.com/v2/repositories/${probeId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${cred.apiKey}`, "x-github-token": cred.githubToken ?? "" },
      });
      // Bad API key → 401 "Invalid API key". Valid key → 404 (probe repo not indexed).
      if (status === 401 && /api key/i.test(text)) return { ok: false, status, detail: "Invalid Greptile API key" };
      if (status === 401 || status === 403) return { ok: false, status, detail: text.slice(0, 120) || "Unauthorized" };
      return { ok: true, status, account: "Greptile", detail: status === 404 ? "Key accepted" : `Key accepted (HTTP ${status})` };
    } catch (e) {
      return { ok: false, status: 0, detail: `network error: ${(e as Error).message}` };
    }
  }
}

export function buildConnectorRegistry(): Record<ConnectorName, Connector> {
  return {
    linear: new LinearConnector(),
    coderabbit: new CodeRabbitConnector(),
    greptile: new GreptileConnector(),
  };
}
