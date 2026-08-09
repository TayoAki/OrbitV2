// ─────────────────────────────────────────────────────────────────────────────
// PostgresStore — the durable implementation of the Store port. Faithful to the
// MemoryStore semantics (optimistic concurrency on runs, append-only idempotent
// events, transactional outbox, webhook dedup, SHA-bound gate snapshots +
// approvals), backed by db/schema.sql. Selected at boot when DATABASE_URL is set;
// otherwise the app falls back to MemoryStore. This is the single swap the README
// promised "nothing above changes" depends on.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
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
  ConnectorRecord,
  ConnectorName,
} from "./domain";
import { slug } from "./domain";

const { Pool } = pg;

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
const isoOrNull = (d: unknown): string | null => (d == null ? null : iso(d));

export class PostgresStore implements Store {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PG_POOL_MAX ?? 10),
    });
  }

  async migrate(): Promise<void> {
    const schemaPath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
    await this.pool.query(readFileSync(schemaPath, "utf8"));
  }

  async seedRepositories(repos: Repository[]): Promise<void> {
    for (const r of repos) {
      await this.pool.query(
        `insert into repositories (id, github_repo_id, installation_id, owner, name, default_branch, enabled, required_checks)
         values ($1,$2,$3,$4,$5,$6,$7,$8::text[])
         on conflict (id) do update set
           github_repo_id=excluded.github_repo_id, installation_id=excluded.installation_id, owner=excluded.owner,
           name=excluded.name, default_branch=excluded.default_branch, enabled=excluded.enabled, required_checks=excluded.required_checks`,
        [r.id, r.githubRepoId, r.installationId, r.owner, r.name, r.defaultBranch, r.enabled, r.requiredChecks],
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── runs ────────────────────────────────────────────────────────────────────
  async createRun(run: Run): Promise<Run> {
    await this.pool.query(
      `insert into runs (id, workspace_id, repository_id, creator_user_id, source_type, source_external_id, title,
        instructions, acceptance_criteria, execution_mode, state, state_version, base_ref, base_sha, branch_name,
        head_sha, pr_number, ci_repair_attempts, review_round, browser_repair_attempts, gate_hash, attention_reason,
        created_at, started_at, completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        run.id, run.workspaceId, run.repositoryId, run.creatorUserId, run.source.type, run.source.externalId ?? null,
        run.title, run.instructions, JSON.stringify(run.acceptanceCriteria), run.executionMode, run.state, run.stateVersion,
        run.baseRef, run.baseSha, run.branchName, run.headSha, run.prNumber, run.ciRepairAttempts, run.reviewRound,
        run.browserRepairAttempts, run.gateHash, run.attentionReason, run.createdAt, run.startedAt, run.completedAt,
      ],
    );
    return run;
  }

  async getRun(id: string): Promise<Run | null> {
    const { rows } = await this.pool.query("select * from runs where id=$1", [id]);
    return rows[0] ? rowToRun(rows[0]) : null;
  }

  async updateRun(id: string, expectedVersion: number, patch: RunPatch): Promise<Run | null> {
    const cols: Record<keyof RunPatch, string> = {
      state: "state", headSha: "head_sha", branchName: "branch_name", prNumber: "pr_number", gateHash: "gate_hash",
      attentionReason: "attention_reason", ciRepairAttempts: "ci_repair_attempts", reviewRound: "review_round",
      browserRepairAttempts: "browser_repair_attempts", startedAt: "started_at", completedAt: "completed_at",
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [k, col] of Object.entries(cols)) {
      if (k in patch) {
        sets.push(`${col}=$${i++}`);
        vals.push((patch as Record<string, unknown>)[k]);
      }
    }
    sets.push(`state_version=state_version+1`);
    vals.push(id, expectedVersion);
    const { rows } = await this.pool.query(
      `update runs set ${sets.join(", ")} where id=$${i++} and state_version=$${i} returning *`,
      vals,
    );
    return rows[0] ? rowToRun(rows[0]) : null; // null on optimistic-concurrency miss
  }

  async listRuns(filter: { workspaceId?: string; repositoryId?: string; attentionOnly?: boolean }): Promise<Run[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (filter.workspaceId) { where.push(`workspace_id=$${i++}`); vals.push(filter.workspaceId); }
    if (filter.repositoryId) { where.push(`repository_id=$${i++}`); vals.push(filter.repositoryId); }
    if (filter.attentionOnly) where.push(`attention_reason is not null and state not in ('DONE','FAILED','CANCELLED')`);
    const sql = `select * from runs ${where.length ? "where " + where.join(" and ") : ""} order by created_at desc`;
    const { rows } = await this.pool.query(sql, vals);
    return rows.map(rowToRun);
  }

  // ── event log ─────────────────────────────────────────────────────────────
  async appendEvent(input: AppendEventInput): Promise<RunEvent | null> {
    const { rows } = await this.pool.query(
      `insert into run_events (id, run_id, sequence, event_type, source, head_sha, idempotency_key, payload, created_at)
       values ($1,$2,(select coalesce(max(sequence),0)+1 from run_events where run_id=$2),$3,$4,$5,$6,$7::jsonb, now())
       on conflict (source, idempotency_key) do nothing
       returning *`,
      [slug(), input.runId, input.eventType, input.source, input.headSha ?? null, input.idempotencyKey, JSON.stringify(input.payload ?? {})],
    );
    return rows[0] ? rowToEvent(rows[0]) : null; // idempotent no-op on duplicate
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const { rows } = await this.pool.query("select * from run_events where run_id=$1 order by sequence asc", [runId]);
    return rows.map(rowToEvent);
  }

  // ── outbox ──────────────────────────────────────────────────────────────────
  async publishOutbox(msg: Omit<OutboxMessage, "id" | "createdAt" | "publishedAt">): Promise<OutboxMessage> {
    const { rows } = await this.pool.query(
      `insert into outbox (id, job_type, run_id, payload) values ($1,$2,$3,$4::jsonb) returning *`,
      [slug(), msg.jobType, msg.runId, JSON.stringify(msg.payload ?? {})],
    );
    return rowToOutbox(rows[0]);
  }

  async claimOutbox(limit: number): Promise<OutboxMessage[]> {
    const { rows } = await this.pool.query(
      `select * from outbox where published_at is null order by created_at asc limit $1 for update skip locked`,
      [limit],
    );
    return rows.map(rowToOutbox);
  }

  async markPublished(id: string): Promise<void> {
    await this.pool.query("update outbox set published_at=now() where id=$1", [id]);
  }

  async recordDelivery(deliveryId: string, event = "", action: string | null = null): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `insert into webhook_deliveries (delivery_id, event, action) values ($1,$2,$3) on conflict (delivery_id) do nothing`,
      [deliveryId, event, action],
    );
    return (rowCount ?? 0) > 0;
  }

  // ── gate snapshots + approvals ───────────────────────────────────────────────
  async saveGateSnapshot(snap: GateSnapshot): Promise<void> {
    const body = { ci: snap.ci, review: snap.review, browser: snap.browser, mergeable: snap.mergeable };
    await this.pool.query("update gate_snapshots set valid=false where run_id=$1", [snap.runId]);
    await this.pool.query(
      `insert into gate_snapshots (run_id, head_sha, hash, body, valid, created_at)
       values ($1,$2,$3,$4::jsonb,true,$5)
       on conflict (run_id, hash) do update set body=excluded.body, valid=true, head_sha=excluded.head_sha`,
      [snap.runId, snap.headSha, snap.hash, JSON.stringify(body), snap.createdAt],
    );
  }

  async getGateSnapshot(runId: string): Promise<GateSnapshot | null> {
    const { rows } = await this.pool.query(
      "select * from gate_snapshots where run_id=$1 and valid order by created_at desc limit 1",
      [runId],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return { runId: r.run_id, headSha: r.head_sha, ...r.body, hash: r.hash, createdAt: iso(r.created_at) };
  }

  async invalidateGateSnapshots(runId: string): Promise<void> {
    await this.pool.query("update gate_snapshots set valid=false where run_id=$1", [runId]);
  }

  async saveApproval(a: Approval): Promise<void> {
    await this.pool.query(
      `insert into approvals (run_id, approved_sha, gate_hash, approver_user_id, valid, created_at)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (run_id, gate_hash) do update set valid=excluded.valid, approved_sha=excluded.approved_sha,
         approver_user_id=excluded.approver_user_id, created_at=excluded.created_at`,
      [a.runId, a.approvedSha, a.gateHash, a.approverUserId, a.valid, a.at],
    );
  }

  async getValidApproval(runId: string): Promise<Approval | null> {
    const { rows } = await this.pool.query(
      "select * from approvals where run_id=$1 and valid order by created_at desc limit 1",
      [runId],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return { runId: r.run_id, approvedSha: r.approved_sha, gateHash: r.gate_hash, approverUserId: r.approver_user_id, at: iso(r.created_at), valid: r.valid };
  }

  async invalidateApprovals(runId: string): Promise<void> {
    await this.pool.query("update approvals set valid=false where run_id=$1", [runId]);
  }

  // ── executors + PRs + repos ──────────────────────────────────────────────────
  async saveExecutor(e: Executor): Promise<void> {
    await this.pool.query(
      `insert into executors (id, run_id, provider, external_id, status, created_at, destroyed_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set status=excluded.status, external_id=excluded.external_id, destroyed_at=excluded.destroyed_at`,
      [e.id, e.runId, e.provider, e.externalId, e.status, e.createdAt, e.destroyedAt],
    );
  }

  async getExecutorForRun(runId: string): Promise<Executor | null> {
    const { rows } = await this.pool.query("select * from executors where run_id=$1 order by created_at desc limit 1", [runId]);
    return rows[0] ? rowToExecutor(rows[0]) : null;
  }

  async liveExecutorsForTerminalRuns(): Promise<Executor[]> {
    const { rows } = await this.pool.query(
      `select e.* from executors e join runs r on r.id=e.run_id
       where r.state in ('DONE','FAILED','CANCELLED') and e.status <> 'DESTROYED'`,
    );
    return rows.map(rowToExecutor);
  }

  async savePullRequest(pr: PullRequestRecord): Promise<void> {
    await this.pool.query(
      `insert into pull_requests (run_id, pr_number, head_sha, branch, base, mergeable, merged)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (run_id) do update set pr_number=excluded.pr_number, head_sha=excluded.head_sha, branch=excluded.branch,
         base=excluded.base, mergeable=excluded.mergeable, merged=excluded.merged`,
      [pr.runId, pr.prNumber, pr.headSha, pr.branch, pr.base, pr.mergeable, pr.merged],
    );
  }

  async getPullRequest(runId: string): Promise<PullRequestRecord | null> {
    const { rows } = await this.pool.query("select * from pull_requests where run_id=$1", [runId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { runId: r.run_id, prNumber: r.pr_number, headSha: r.head_sha, branch: r.branch, base: r.base, mergeable: r.mergeable, merged: r.merged };
  }

  async getRepository(id: string): Promise<Repository | null> {
    const { rows } = await this.pool.query("select * from repositories where id=$1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, githubRepoId: Number(r.github_repo_id), installationId: Number(r.installation_id), owner: r.owner, name: r.name, defaultBranch: r.default_branch, enabled: r.enabled, requiredChecks: r.required_checks };
  }

  // ── runner enrollment ────────────────────────────────────────────────────────
  async createEnrollmentNonce(runId: string): Promise<string> {
    const nonce = slug() + slug();
    await this.pool.query("insert into enrollment_nonces (nonce, run_id) values ($1,$2)", [nonce, runId]);
    return nonce;
  }

  async redeemEnrollmentNonce(nonce: string): Promise<{ runId: string } | null> {
    const { rows } = await this.pool.query("delete from enrollment_nonces where nonce=$1 returning run_id", [nonce]);
    return rows[0] ? { runId: rows[0].run_id } : null;
  }

  // ── connectors ───────────────────────────────────────────────────────────────
  async saveConnector(rec: ConnectorRecord): Promise<void> {
    await this.pool.query(
      `insert into connectors (workspace_id, provider, category, display_name, status, account_label,
        encrypted_key, encrypted_github_token, detail, last_validated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (workspace_id, provider) do update set category=excluded.category, display_name=excluded.display_name,
         status=excluded.status, account_label=excluded.account_label, encrypted_key=excluded.encrypted_key,
         encrypted_github_token=excluded.encrypted_github_token, detail=excluded.detail, last_validated_at=excluded.last_validated_at`,
      [rec.workspaceId, rec.provider, rec.category, rec.displayName, rec.status, rec.accountLabel,
       rec.encryptedKey, rec.encryptedGithubToken, rec.detail, rec.lastValidatedAt],
    );
  }
  async getConnector(workspaceId: string, provider: ConnectorName): Promise<ConnectorRecord | null> {
    const { rows } = await this.pool.query("select * from connectors where workspace_id=$1 and provider=$2", [workspaceId, provider]);
    return rows[0] ? rowToConnector(rows[0]) : null;
  }
  async listConnectors(workspaceId: string): Promise<ConnectorRecord[]> {
    const { rows } = await this.pool.query("select * from connectors where workspace_id=$1", [workspaceId]);
    return rows.map(rowToConnector);
  }
  async deleteConnector(workspaceId: string, provider: ConnectorName): Promise<void> {
    await this.pool.query("delete from connectors where workspace_id=$1 and provider=$2", [workspaceId, provider]);
  }
}

// ── row → domain mappers ───────────────────────────────────────────────────────
function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    repositoryId: r.repository_id as string,
    creatorUserId: r.creator_user_id as string,
    source: { type: r.source_type as Run["source"]["type"], externalId: (r.source_external_id as string) ?? undefined },
    title: r.title as string,
    instructions: r.instructions as string,
    acceptanceCriteria: r.acceptance_criteria as Run["acceptanceCriteria"],
    executionMode: r.execution_mode as Run["executionMode"],
    state: r.state as Run["state"],
    stateVersion: Number(r.state_version),
    baseRef: r.base_ref as string,
    baseSha: r.base_sha as string,
    branchName: (r.branch_name as string) ?? null,
    headSha: (r.head_sha as string) ?? null,
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
    ciRepairAttempts: Number(r.ci_repair_attempts),
    reviewRound: Number(r.review_round),
    browserRepairAttempts: Number(r.browser_repair_attempts),
    gateHash: (r.gate_hash as string) ?? null,
    attentionReason: (r.attention_reason as Run["attentionReason"]) ?? null,
    createdAt: iso(r.created_at),
    startedAt: isoOrNull(r.started_at),
    completedAt: isoOrNull(r.completed_at),
  };
}

function rowToEvent(r: Record<string, unknown>): RunEvent {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    sequence: Number(r.sequence),
    eventType: r.event_type as RunEvent["eventType"],
    source: r.source as RunEvent["source"],
    headSha: (r.head_sha as string) ?? null,
    idempotencyKey: r.idempotency_key as string,
    payload: (r.payload as Record<string, unknown>) ?? {},
    createdAt: iso(r.created_at),
  };
}

function rowToOutbox(r: Record<string, unknown>): OutboxMessage {
  return {
    id: r.id as string,
    jobType: r.job_type as OutboxMessage["jobType"],
    runId: r.run_id as string,
    payload: (r.payload as Record<string, unknown>) ?? {},
    createdAt: iso(r.created_at),
    publishedAt: isoOrNull(r.published_at),
  };
}

function rowToConnector(r: Record<string, unknown>): ConnectorRecord {
  return {
    workspaceId: r.workspace_id as string,
    provider: r.provider as ConnectorRecord["provider"],
    category: r.category as string,
    displayName: r.display_name as string,
    status: r.status as ConnectorRecord["status"],
    accountLabel: (r.account_label as string) ?? null,
    encryptedKey: (r.encrypted_key as string) ?? null,
    encryptedGithubToken: (r.encrypted_github_token as string) ?? null,
    detail: (r.detail as string) ?? null,
    lastValidatedAt: isoOrNull(r.last_validated_at),
  };
}

function rowToExecutor(r: Record<string, unknown>): Executor {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    provider: r.provider as string,
    externalId: (r.external_id as string) ?? null,
    status: r.status as Executor["status"],
    createdAt: iso(r.created_at),
    destroyedAt: isoOrNull(r.destroyed_at),
  };
}
