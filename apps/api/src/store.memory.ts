// ─────────────────────────────────────────────────────────────────────────────
// In-memory Store. Faithful to the Postgres contract: optimistic concurrency on
// runs, append-only events unique on (source, idempotencyKey), a transactional
// outbox, and webhook-delivery dedup. Swap for a Postgres implementation of the
// same `Store` interface without touching the orchestrator/gate.
// ─────────────────────────────────────────────────────────────────────────────
import type { Store, RunPatch, AppendEventInput } from "./ports";
import type {
  Run,
  RunEvent,
  GateSnapshot,
  Approval,
  Executor,
  Repository,
  PullRequestRecord,
  OutboxMessage,
} from "./domain";
import { slug, isTerminal } from "./domain";

export class MemoryStore implements Store {
  private runs = new Map<string, Run>();
  private events: RunEvent[] = [];
  private eventKeys = new Set<string>(); // `${source}:${idempotencyKey}`
  private seqByRun = new Map<string, number>();
  private outbox: OutboxMessage[] = [];
  private deliveries = new Set<string>();
  private gateSnapshots = new Map<string, GateSnapshot>();
  private approvals = new Map<string, Approval>();
  private executors = new Map<string, Executor>(); // by runId
  private prs = new Map<string, PullRequestRecord>(); // by runId
  private repos = new Map<string, Repository>();
  private nonces = new Map<string, string>(); // nonce -> runId

  constructor(repos: Repository[] = []) {
    for (const r of repos) this.repos.set(r.id, r);
  }

  async createRun(run: Run): Promise<Run> {
    this.runs.set(run.id, { ...run });
    return { ...run };
  }
  async getRun(id: string): Promise<Run | null> {
    const r = this.runs.get(id);
    return r ? { ...r } : null;
  }
  async updateRun(id: string, expectedVersion: number, patch: RunPatch): Promise<Run | null> {
    const cur = this.runs.get(id);
    if (!cur || cur.stateVersion !== expectedVersion) return null; // optimistic-concurrency miss
    const next: Run = { ...cur, ...patch, stateVersion: cur.stateVersion + 1 };
    this.runs.set(id, next);
    return { ...next };
  }
  async listRuns(filter: { workspaceId?: string; repositoryId?: string; attentionOnly?: boolean }): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((r) => (filter.workspaceId ? r.workspaceId === filter.workspaceId : true))
      .filter((r) => (filter.repositoryId ? r.repositoryId === filter.repositoryId : true))
      .filter((r) => (filter.attentionOnly ? r.attentionReason !== null && !isTerminal(r.state) : true))
      .map((r) => ({ ...r }));
  }

  async appendEvent(input: AppendEventInput): Promise<RunEvent | null> {
    const key = `${input.source}:${input.idempotencyKey}`;
    if (this.eventKeys.has(key)) return null; // idempotent no-op
    this.eventKeys.add(key);
    const seq = (this.seqByRun.get(input.runId) ?? 0) + 1;
    this.seqByRun.set(input.runId, seq);
    const ev: RunEvent = {
      id: slug(),
      runId: input.runId,
      sequence: seq,
      eventType: input.eventType,
      source: input.source,
      headSha: input.headSha ?? null,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    };
    this.events.push(ev);
    return { ...ev };
  }
  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.events.filter((e) => e.runId === runId).map((e) => ({ ...e }));
  }

  async publishOutbox(msg: Omit<OutboxMessage, "id" | "createdAt" | "publishedAt">): Promise<OutboxMessage> {
    const full: OutboxMessage = { ...msg, id: slug(), createdAt: new Date().toISOString(), publishedAt: null };
    this.outbox.push(full);
    return { ...full };
  }
  async claimOutbox(limit: number): Promise<OutboxMessage[]> {
    const claimed = this.outbox.filter((m) => m.publishedAt === null).slice(0, limit);
    return claimed.map((m) => ({ ...m }));
  }
  async markPublished(id: string): Promise<void> {
    const m = this.outbox.find((x) => x.id === id);
    if (m) m.publishedAt = new Date().toISOString();
  }

  async recordDelivery(deliveryId: string): Promise<boolean> {
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.add(deliveryId);
    return true;
  }

  async saveGateSnapshot(snap: GateSnapshot): Promise<void> {
    this.gateSnapshots.set(snap.runId, { ...snap });
  }
  async getGateSnapshot(runId: string): Promise<GateSnapshot | null> {
    const s = this.gateSnapshots.get(runId);
    return s ? { ...s } : null;
  }
  async invalidateGateSnapshots(runId: string): Promise<void> {
    this.gateSnapshots.delete(runId);
  }
  async saveApproval(a: Approval): Promise<void> {
    this.approvals.set(a.runId, { ...a });
  }
  async getValidApproval(runId: string): Promise<Approval | null> {
    const a = this.approvals.get(runId);
    return a && a.valid ? { ...a } : null;
  }
  async invalidateApprovals(runId: string): Promise<void> {
    const a = this.approvals.get(runId);
    if (a) a.valid = false;
  }

  async saveExecutor(e: Executor): Promise<void> {
    this.executors.set(e.runId, { ...e });
  }
  async getExecutorForRun(runId: string): Promise<Executor | null> {
    const e = this.executors.get(runId);
    return e ? { ...e } : null;
  }
  async liveExecutorsForTerminalRuns(): Promise<Executor[]> {
    const out: Executor[] = [];
    for (const e of this.executors.values()) {
      const run = this.runs.get(e.runId);
      if (run && isTerminal(run.state) && e.status !== "DESTROYED") out.push({ ...e });
    }
    return out;
  }
  async savePullRequest(pr: PullRequestRecord): Promise<void> {
    this.prs.set(pr.runId, { ...pr });
  }
  async getPullRequest(runId: string): Promise<PullRequestRecord | null> {
    const p = this.prs.get(runId);
    return p ? { ...p } : null;
  }
  async getRepository(id: string): Promise<Repository | null> {
    const r = this.repos.get(id);
    return r ? { ...r } : null;
  }

  async createEnrollmentNonce(runId: string): Promise<string> {
    const nonce = slug() + slug();
    this.nonces.set(nonce, runId);
    return nonce;
  }
  async redeemEnrollmentNonce(nonce: string): Promise<{ runId: string } | null> {
    const runId = this.nonces.get(nonce);
    if (!runId) return null;
    this.nonces.delete(nonce); // single-use
    return { runId };
  }
}
