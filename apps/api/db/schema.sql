-- ─────────────────────────────────────────────────────────────────────────────
-- Shipbot control-plane schema (Postgres). This is the durable authority. The
-- in-memory MemoryStore mirrors these tables 1:1; swapping it for a Postgres-backed
-- Store implementing the same `Store` port is the only change needed to persist.
--
-- Load-bearing constraints are encoded here, NOT left to application code:
--   • one in-flight run per (repo, branch)            → uniq_active_run_branch
--   • append-only event log, idempotent + gap-free     → uniq_event_idem / uniq_event_seq
--   • webhook delivery dedup                           → webhook_deliveries PK
--   • optimistic concurrency on runs                   → runs.state_version
--   • an approval is bound to a SHA + a gate hash       → approvals.approved_sha/gate_hash
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists repositories (
  id                text primary key,
  github_repo_id    bigint not null unique,
  installation_id   bigint not null,
  owner             text not null,
  name              text not null,
  default_branch    text not null,
  enabled           boolean not null default true,
  -- Snapshotted from the BASE commit at enrollment; never read from an agent head.
  required_checks   text[] not null default '{}'
);

create table if not exists runs (
  id                 text primary key,
  workspace_id       text not null,
  repository_id      text not null references repositories(id),
  creator_user_id    text not null,
  source_type        text not null,
  source_external_id text,
  title              text not null,
  instructions       text not null,
  acceptance_criteria jsonb not null default '{"criteria":[],"browserRequired":false}',
  execution_mode     text not null default 'SUPERVISED' check (execution_mode in ('SUPERVISED','AUTONOMOUS')),
  state              text not null,
  state_version      integer not null default 0,          -- optimistic-concurrency guard
  base_ref           text not null,
  base_sha           text not null,
  branch_name        text,
  head_sha           text,
  pr_number          integer,
  ci_repair_attempts    integer not null default 0,
  review_round          integer not null default 0,
  browser_repair_attempts integer not null default 0,
  gate_hash          text,
  attention_reason   text,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  completed_at       timestamptz
);

-- At most one non-terminal run per branch (the agent's one allowed branch).
create unique index if not exists uniq_active_run_branch
  on runs (repository_id, branch_name)
  where branch_name is not null and state not in ('DONE','FAILED','CANCELLED');

-- The inbox is a query, not a table: attention_reason set on a live run.
create index if not exists idx_runs_inbox on runs (workspace_id) where attention_reason is not null and state not in ('DONE','FAILED','CANCELLED');

create table if not exists run_events (
  id              text primary key,
  run_id          text not null references runs(id),
  sequence        integer not null,
  event_type      text not null,
  source          text not null,     -- control_plane | runner | github | review_provider | human | reconciler
  head_sha        text,
  idempotency_key text not null,
  payload         jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  constraint uniq_event_idem unique (source, idempotency_key),  -- idempotent apply
  constraint uniq_event_seq  unique (run_id, sequence)          -- gap-free per-run order
);

-- Transactional outbox: written in the same tx as the state change, drained async.
create table if not exists outbox (
  id           text primary key,
  job_type     text not null,
  run_id       text not null,
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  published_at timestamptz
);
create index if not exists idx_outbox_unpublished on outbox (created_at) where published_at is null;

-- Webhook dedup — GitHub guarantees at-least-once, so the delivery id is the key.
create table if not exists webhook_deliveries (
  delivery_id text primary key,
  event       text not null,
  action      text,
  received_at timestamptz not null default now()
);

-- Immutable gate snapshot: the exact set of green facts, hashed. The human approves
-- this hash; merge is conditioned on it.
create table if not exists gate_snapshots (
  run_id     text not null references runs(id),
  head_sha   text not null,
  hash       text not null,
  body       jsonb not null,      -- {ci, review, browser, mergeable}
  valid      boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (run_id, hash)
);

-- An approval is bound to a SHA and a gate hash. Merge re-verifies head == approved_sha.
create table if not exists approvals (
  run_id          text not null references runs(id),
  approved_sha    text not null,
  gate_hash       text not null,
  approver_user_id text not null,
  valid           boolean not null default true,
  created_at      timestamptz not null default now(),
  primary key (run_id, gate_hash)
);

create table if not exists executors (
  id           text primary key,
  run_id       text not null references runs(id),
  provider     text not null,
  external_id  text,
  status       text not null,   -- PROVISIONING | AVAILABLE | STOPPED | DESTROYED | FAILED
  created_at   timestamptz not null default now(),
  destroyed_at timestamptz
);
create unique index if not exists uniq_executor_active_per_run on executors (run_id) where status <> 'DESTROYED';

create table if not exists pull_requests (
  run_id    text primary key references runs(id),
  pr_number integer not null,
  head_sha  text not null,
  branch    text not null,
  base      text not null,
  mergeable text not null,
  merged    boolean not null default false
);

-- Single-use runner enrollment nonces (exchanged for a scoped runner session).
create table if not exists enrollment_nonces (
  nonce      text primary key,
  run_id     text not null references runs(id),
  created_at timestamptz not null default now(),
  redeemed_at timestamptz
);
