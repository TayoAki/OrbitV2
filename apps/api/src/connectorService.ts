// ─────────────────────────────────────────────────────────────────────────────
// ConnectorService — connect/test/list/disconnect for the real tool integrations.
// Validates a credential by making a live API call, then stores it ENCRYPTED via
// the SecretStore. Public responses never include the key — only status + account.
// ─────────────────────────────────────────────────────────────────────────────
import type { Deps } from "./ports";
import type { ConnectorName, ConnectorStatus } from "./domain";
import { HttpError } from "./runService";
import type { Connector, ConnectorCredential, ValidationResult, LinearIssue } from "./connectors";
import { LinearConnector } from "./connectors";

export interface PublicConnector {
  provider: ConnectorName;
  displayName: string;
  category: string;
  needsGithubToken: boolean;
  status: ConnectorStatus;
  accountLabel: string | null;
  detail: string | null;
  lastValidatedAt: string | null;
}

export class ConnectorService {
  constructor(private deps: Deps, private registry: Record<ConnectorName, Connector>) {}

  private provider(name: string): Connector {
    const c = this.registry[name as ConnectorName];
    if (!c) throw new HttpError(404, `unknown connector: ${name}`);
    return c;
  }

  async list(workspaceId: string): Promise<PublicConnector[]> {
    const stored = await this.deps.store.listConnectors(workspaceId);
    const byProv = new Map(stored.map((r) => [r.provider, r] as const));
    return (Object.keys(this.registry) as ConnectorName[]).map((p) => {
      const c = this.registry[p];
      const rec = byProv.get(p);
      return {
        provider: p,
        displayName: c.displayName,
        category: c.category,
        needsGithubToken: c.needsGithubToken,
        status: rec?.status ?? "not_configured",
        accountLabel: rec?.accountLabel ?? null,
        detail: rec?.detail ?? null,
        lastValidatedAt: rec?.lastValidatedAt ?? null,
      };
    });
  }

  /** Validate a credential against the live API; persist only if it authenticates. */
  async connect(workspaceId: string, providerName: string, cred: ConnectorCredential): Promise<ValidationResult> {
    const c = this.provider(providerName);
    if (!cred.apiKey) throw new HttpError(400, "apiKey is required");
    if (c.needsGithubToken && !cred.githubToken) throw new HttpError(400, `githubToken is required for ${c.name}`);

    const result = await c.validate(cred);
    if (result.ok) {
      await this.deps.store.saveConnector({
        workspaceId,
        provider: c.name,
        category: c.category,
        displayName: c.displayName,
        status: "connected",
        accountLabel: result.account ?? null,
        encryptedKey: await this.deps.secrets.encrypt(cred.apiKey),
        encryptedGithubToken: cred.githubToken ? await this.deps.secrets.encrypt(cred.githubToken) : null,
        detail: result.detail,
        lastValidatedAt: new Date().toISOString(),
      });
    }
    return result; // never contains the key
  }

  /** Re-validate the stored credential against the live API. */
  async test(workspaceId: string, providerName: string): Promise<ValidationResult> {
    const c = this.provider(providerName);
    const rec = await this.deps.store.getConnector(workspaceId, c.name);
    if (!rec || !rec.encryptedKey) throw new HttpError(404, `${c.name} is not connected`);
    const cred: ConnectorCredential = {
      apiKey: await this.deps.secrets.decrypt(rec.encryptedKey),
      githubToken: rec.encryptedGithubToken ? await this.deps.secrets.decrypt(rec.encryptedGithubToken) : undefined,
    };
    const result = await c.validate(cred);
    await this.deps.store.saveConnector({
      ...rec,
      status: result.ok ? "connected" : "error",
      accountLabel: result.account ?? rec.accountLabel,
      detail: result.detail,
      lastValidatedAt: new Date().toISOString(),
    });
    return result;
  }

  async disconnect(workspaceId: string, providerName: string): Promise<void> {
    const c = this.provider(providerName);
    await this.deps.store.deleteConnector(workspaceId, c.name);
  }

  /** Live: pull issues from Linear (proves the connector does real work). */
  async linearIssues(workspaceId: string): Promise<LinearIssue[]> {
    const rec = await this.deps.store.getConnector(workspaceId, "linear");
    if (!rec || !rec.encryptedKey) throw new HttpError(404, "linear is not connected");
    const key = await this.deps.secrets.decrypt(rec.encryptedKey);
    const linear = this.registry.linear as LinearConnector;
    return linear.listIssues({ apiKey: key });
  }
}
