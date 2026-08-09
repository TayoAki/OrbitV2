# Deploying Orbit to Railway

## Live deployment (Railway project `orbit`)

| Service | URL | Status |
| --- | --- | --- |
| **orbit-api** (control plane) | https://orbit-api-production-df5e.up.railway.app | ✅ Postgres-backed; full ship-loop verified end-to-end (create → PR → CI → review → gate → approve → merge) |
| **orbit-web** (console) | https://orbit-web-production-b441.up.railway.app | ✅ serving |
| **Postgres** | private (`postgres.railway.internal`) | ✅ schema migrated + seeded on boot |

Build is monorepo-via-upload: `railway up` uploads the repo root; each service's
`dockerfilePath` selects `Dockerfile.api` / `Dockerfile.web` (root context, each
copies only its own app). The control plane runs at **1 replica** (its in-memory
locks + in-process outbox pump require a single instance).

---

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

> **Monorepo note.** `railway up` uploads the **repo root**, so each service is
> pointed at a root-context Dockerfile via its `dockerfilePath`
> (`Dockerfile.api` / `Dockerfile.web`) with an empty root directory. Set that once
> per service (dashboard → Settings → Build, or the `serviceInstanceUpdate` GraphQL
> mutation shown in the session). Then `railway up` from the repo root just works.

## Deploy the control plane (orbit-api)

```bash
railway add -s orbit-api
railway variable set "SHIPBOT_WEBHOOK_SECRET=$(openssl rand -hex 32)" -s orbit-api --skip-deploys
railway variable set 'DATABASE_URL=${{Postgres.DATABASE_URL}}'        -s orbit-api --skip-deploys
railway variable set 'DATABASE_SSL=true'                             -s orbit-api --skip-deploys
# one-time: set dockerfilePath=Dockerfile.api, rootDirectory="", healthcheckPath=/healthz, numReplicas=1
railway up -s orbit-api -c                  # build from repo root, stream logs
railway domain -s orbit-api                 # mint a public URL
```

On boot the API logs `store: postgres (migrated + seeded)` — the schema
(`apps/api/db/schema.sql`) is applied idempotently on every start.

## Deploy the console (orbit-web)

`NEXT_PUBLIC_API_URL` is inlined at **build** time, so set it before deploying.

```bash
railway add -s orbit-web
railway variable set "NEXT_PUBLIC_API_URL=https://<orbit-api-domain>" -s orbit-web --skip-deploys
# one-time: set dockerfilePath=Dockerfile.web, rootDirectory="", healthcheckPath=/
railway up -s orbit-web -c
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
