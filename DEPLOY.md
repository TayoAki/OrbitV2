# Deploying Orbit to Railway

Orbit is a monorepo with three deployable concerns:

| Service | Source | Runtime | Notes |
| --- | --- | --- | --- |
| **orbit-api** | `apps/api` | persistent Node process | the control plane — always-on, **1 replica** (in-memory locks + in-process pump) |
| **orbit-web** | `apps/web` | Next.js standalone server | the console UI |
| **Postgres** | Railway plugin | managed Postgres | durable store; `apps/api` uses it when `DATABASE_URL` is set |

> The execution plane (the agent sandbox) is a **separate** hardware-isolated
> microVM (E2B / Vercel Sandbox / self-hosted Firecracker) and is **not** a Railway
> service — see `PLATFORM_PLAN.md`.

## One-time setup (already done for this repo)

```bash
railway init --name orbit        # creates the project, links this dir
railway add -d postgres          # provisions managed Postgres
```

## Deploy the control plane (orbit-api)

```bash
# create + link the service, then deploy apps/api
railway add -s orbit-api
railway service orbit-api
# required + Postgres wiring (reference the Postgres service's DATABASE_URL)
railway variables -s orbit-api \
  --set "SHIPBOT_WEBHOOK_SECRET=$(openssl rand -hex 32)" \
  --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  --set "DATABASE_SSL=true"
railway up apps/api -s orbit-api -c        # build from the Dockerfile, stream logs
railway domain -s orbit-api                 # mint a public URL
```

On boot the API logs `store: postgres (migrated + seeded)` — the schema
(`apps/api/db/schema.sql`) is applied idempotently on every start.

## Deploy the console (orbit-web)

`NEXT_PUBLIC_API_URL` is inlined at **build** time, so set it before deploying.

```bash
railway add -s orbit-web
railway service orbit-web
railway variables -s orbit-web --set "NEXT_PUBLIC_API_URL=https://<orbit-api-domain>"
railway up apps/web -s orbit-web -c
railway domain -s orbit-web
```

## Verify

```bash
curl -s https://<orbit-api-domain>/healthz                       # {"ok":true}
curl -s https://<orbit-api-domain>/v1/runs -XPOST \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"ws","repositoryId":"repo_demo","creatorUserId":"me","title":"smoke","instructions":"ship it"}'
# poll the run — the self-driving demo world takes it to AWAITING_HUMAN, then:
curl -s https://<orbit-api-domain>/v1/runs/<id>/approve -XPOST \
  -H 'content-type: application/json' -d '{"approverUserId":"me","approverGithubUserId":1}'
```

## What is live vs. next

**Live now:** a persistent, Postgres-backed control plane running the real run
state machine (SHA-bound gating, gate snapshot, merge-race guard, bounded repairs,
idempotent event log, webhook HMAC) with a self-driving demo world that carries a
created run all the way to a merged PR; and the console UI.

**Next (Phase A → real PRs):** the console still renders from its sim engine — the
live-data seam is `apps/web/lib/api.ts` + the SSE stream. Replacing the sim with
these calls, plus wiring the real GitHub App, the runner-ingress API, and a
Copilot-SDK agent in the sandbox, turns the demo into a tool that ships real PRs.
See `PLATFORM_PLAN.md` and the readiness map for the full sequence.
