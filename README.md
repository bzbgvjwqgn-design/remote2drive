# remote-to-drive

Stream a remote URL straight into Google Drive. The server never writes the file
to disk and never holds more than two chunks in RAM, so a 40 GB transfer costs
the same disk and memory as a 4 MB one.

Built to run on **many VPS nodes at once**: the app and worker containers are
stateless, all state lives in a shared Postgres and Redis, and a job whose node
dies mid-transfer is picked up and **resumed** by another worker rather than
restarted.

```
                        ┌──────────────┐
   browser ──HTTPS──►   │ Caddy/Nginx  │
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌──────────┐     ┌──────────┐     ┌──────────┐
        │ app:web  │     │ app:web  │     │app:both  │   ROLE env var picks
        └────┬─────┘     └────┬─────┘     └─┬──────┬─┘   the behaviour
             │                │             │      │
             │      ┌─────────▼─────────────▼──┐   │
             └─────►│  PostgreSQL  (authoritative state)   │
                    │  users · tokens · jobs · leases · logs│
                    └──────────────────────────┘
             ┌─────►│  Redis  (BullMQ queue · progress pub/sub · rate limits)
             │      └──────────────────────────┘
        ┌────┴─────┐     ┌──────────┐
        │app:worker│     │app:worker│  ← add as many as you like
        └────┬─────┘     └────┬─────┘
             │  pipes bytes    │
             ▼                 ▼
        source URL ──────► Google Drive (resumable upload)
```

Every worker pulls from the same queue and writes to the same Drive session
protocol, so capacity is added by starting another container, not by changing
code.

> **Just want to deploy it?** Follow **[DEPLOY.md](DEPLOY.md)** — a numbered,
> copy-paste walkthrough from a fresh VPS to a multi-node fleet. The rest of this
> file explains how the system works.

---

## Table of contents

- [Features](#features)
- [How a transfer works](#how-a-transfer-works)
- [How failover works](#how-failover-works)
- [Project layout](#project-layout)
- [Deployment guide (step by step)](DEPLOY.md)
- [1. Google Cloud Console setup](#1-google-cloud-console-setup)
- [2. Configure the environment](#2-configure-the-environment)
- [3. Deploy to one VPS](#3-deploy-to-one-vps)
- [4. Scale to multiple VPS](#4-scale-to-multiple-vps)
- [5. TLS and load balancing](#5-tls-and-load-balancing)
- [Operations](#operations)
- [HTTP API](#http-api)
- [Security model](#security-model)
- [Development](#development)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

---

## Features

| Area | What you get |
| --- | --- |
| Submission | Web UI and REST API, one URL or a batch, optional filename and destination folder |
| Auth | Google OAuth2 with the narrow `drive.file` scope; refresh tokens sealed with AES-256-GCM |
| Transfer | Source → Drive streaming, chunked resumable upload, 256 KiB-aligned chunks |
| Resume | HTTP `Range` on the download, stored session URI + Drive's confirmed offset on the upload |
| Progress | Server-Sent Events with percent, speed, ETA, phase |
| Jobs | queued / transferring / completed / failed / cancelled, retry with exponential backoff, cancel, history |
| Scale | Stateless containers, shared Postgres + Redis, `ROLE=web\|worker\|both` |
| Failover | Postgres lease with heartbeat and epoch fencing; a dead node's jobs resume elsewhere |
| Abuse defence | SSRF blocklist with per-hop re-validation, per-user rate limits, size caps, active-job caps |
| Ops | `/healthz`, `/readyz`, admin dashboard of nodes, load and stuck jobs |

### Edge cases handled explicitly

Redirects (re-validated at every hop) · `Content-Disposition` filenames including
RFC 6266 `filename*` · unknown `Content-Length` · expired access tokens (auto
refresh, rotated refresh tokens re-sealed) · Drive quota exceeded (a message the
user can act on) · duplicate filenames (configurable rename) · sources that
refuse `HEAD` · sources that advertise `Range` support but ignore it · chunks
whose HTTP response was lost after Drive already stored them.

---

## How a transfer works

```
probe   HEAD the source (falls back to a 1-byte ranged GET on 405/403/…)
          └─► size, Content-Type, Content-Disposition, Range support
name    resolve the filename, de-duplicate against the target folder
session POST uploadType=resumable ──► session URI (encrypted, stored in Postgres)
stream  source socket ─► [size limiter] ─► [bandwidth throttle] ─► chunker ─► PUT
                                                                      │
                            308 Resume Incomplete ◄───────────────────┘
finalize Drive returns 200 with the file metadata
```

Two properties matter:

**Memory is bounded.** The chunker pre-allocates one `chunkSize` buffer and
copies into it — it never concatenates. The uploader holds the *previous* chunk
while the next one fills, which is what lets it know which chunk is last when
the source never declared a length. Steady-state footprint is ~2 × `CHUNK_SIZE_MB`
per active job.

**Drive's offset is the source of truth.** If a chunk's response is lost, the
worker asks Drive how many bytes it actually holds and resends only the
remainder. Resending a chunk that already landed would corrupt the file.

---

## How failover works

BullMQ alone is not enough. A node that is merely *slow* — long GC pause,
saturated disk, network stall — can outlive its queue lock while still being
alive and still writing to the Drive upload session. Two writers on one
resumable session corrupt the file.

So ownership lives in Postgres:

1. Before the first byte moves, the worker takes a **lease** on the job row with
   an atomic `UPDATE … WHERE lease_owner IS NULL OR lease_expires_at < now()`,
   which increments `lease_epoch`. The epoch is a fencing token.
2. A heartbeat renews it every `LEASE_HEARTBEAT_MS`. A failed renew means
   somebody else owns the job now — the worker **aborts immediately** and leaves
   the row untouched so it cannot race the new owner.
3. Every node runs a reconciler on an interval. Jobs still `TRANSFERRING` whose
   lease expired are requeued with `errorCode = NODE_LOST`, or marked `FAILED`
   with `MAX_ATTEMPTS` once the retry budget is gone.
4. The next worker decrypts the stored session URI, asks Drive for its offset,
   reopens the download at exactly that byte, and continues.

A database blip during a heartbeat is deliberately *not* treated as lost
ownership — the TTL provides the slack. Only a definitive "you do not own this"
answer aborts the transfer.

---

## Project layout

```
.
├── src
│   ├── index.ts                 # boot: load config, pick role, wire shutdown
│   ├── config.ts                # env → validated AppConfig (refuses to boot when invalid)
│   ├── logger.ts                # pino, with secrets redacted
│   ├── crypto.ts                # AES-256-GCM sealing, signed session cookies
│   ├── db.ts / redis.ts         # connection singletons
│   ├── lib
│   │   ├── ssrf.ts              # IP parsing, CIDR blocklist, DNS pinning
│   │   ├── http.ts              # redirect-following fetch, re-validating every hop
│   │   ├── drive.ts             # resumable upload protocol client
│   │   ├── transfer.ts          # probe → name → session → stream → finalize
│   │   ├── filename.ts          # Content-Disposition, sanitizing, de-duplication
│   │   ├── progress.ts          # Redis pub/sub + SSE snapshots + cancel signals
│   │   ├── queue.ts             # BullMQ wrapper with deterministic job ids
│   │   ├── rate.ts              # bandwidth throttle, speed/ETA meter
│   │   ├── tokens.ts            # encrypted refresh tokens and session URIs
│   │   ├── backoff.ts           # jittered exponential retry delay
│   │   ├── errors.ts            # typed error codes, user-facing message policy
│   │   └── serialize.ts         # job rows → API DTOs
│   ├── web
│   │   ├── server.ts            # Fastify app, rate limiting, static, error handler
│   │   ├── auth.ts              # session cookies, CSRF, admin gate
│   │   └── routes/              # auth, jobs, drive, events (SSE), admin, health
│   └── worker
│       ├── worker.ts            # BullMQ consumer + graceful drain
│       ├── processor.ts         # one job end to end, with lease and cancel wiring
│       ├── lease.ts             # Postgres lease, epoch fencing, heartbeat
│       ├── reconciler.ts        # dead-lease recovery + due-job enqueueing
│       └── registry.ts          # node heartbeat for the admin page
├── public/                      # dependency-free HTML/CSS/JS UI
├── prisma/schema.prisma         # users, google_accounts, jobs, job_logs, nodes
├── test/                        # SSRF, filenames, chunking, upload, pipeline, recovery
├── docker/entrypoint.sh         # migrate deploy → start
├── deploy/caddy/Caddyfile       # auto-HTTPS single node
├── deploy/nginx/lb.conf         # multi-node load balancer (SSE-aware)
├── docker-compose.yml           # one VPS: postgres + redis + migrate + app + caddy
├── docker-compose.worker.yml    # extra worker-only VPS
├── docker-compose.web.yml       # extra web-only VPS
├── DEPLOY.md                    # step-by-step deployment walkthrough
└── README.md
```

---

## 1. Google Cloud Console setup

1. Go to <https://console.cloud.google.com/> and create (or select) a project.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen**
   - User type: **External** (unless you have Google Workspace and want
     **Internal**, which skips the review process entirely).
   - Fill in the app name, support email and developer email.
   - **Scopes → Add or remove scopes** → add exactly:
     `https://www.googleapis.com/auth/drive.file`
     plus the defaults `openid`, `email`, `profile`.
   - Add your own account under **Test users** while the app is in *Testing*.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - **Authorized JavaScript origins**: `https://drive.example.com`
   - **Authorized redirect URIs**: `https://drive.example.com/auth/google/callback`
     — must match `GOOGLE_REDIRECT_URI` *exactly*, including scheme and trailing
     path. Add one entry per public hostname you serve.
5. Copy the **Client ID** and **Client secret** into your `.env`.

> **Why `drive.file`?** It grants access only to files and folders *this app*
> created or that the user explicitly picked in a Drive dialog. It can never read
> the rest of the user's Drive, and it keeps you out of Google's sensitive-scope
> verification review.

Publishing to production: the consent screen must move from *Testing* to
*In production* for accounts other than your test users. With only `drive.file`
(no restricted scopes) this normally does not require a security assessment.

---

## 2. Configure the environment

```bash
cp .env.example .env
```

Generate the two secrets — they must be **identical on every node**:

```bash
# Session cookie signing key (>= 32 chars)
openssl rand -base64 48

# Token encryption key (exactly 32 bytes, hex encoded)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The minimum you must set:

| Variable | Notes |
| --- | --- |
| `APP_URL` | Public origin, e.g. `https://drive.example.com` |
| `SESSION_SECRET` | ≥ 32 chars. Rotating it signs everybody out. |
| `TOKEN_ENCRYPTION_KEY` | 64 hex chars. Rotating it makes every stored refresh token unreadable — users must reconnect Drive. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From step 1 |
| `GOOGLE_REDIRECT_URI` | Leave empty to derive `${APP_URL}/auth/google/callback` |
| `DATABASE_URL` | Shared Postgres |
| `REDIS_URL` | Shared Redis |
| `ADMIN_EMAILS` | Comma-separated; these accounts see `/admin.html` |

Everything else has a working default. The full annotated list is in
[`.env.example`](.env.example). The process **refuses to boot** on a missing or
malformed value and prints exactly which one.

### Tuning knobs worth knowing

| Variable | Default | Effect |
| --- | --- | --- |
| `MAX_CONCURRENT_JOBS` | 4 | Jobs per worker process. RAM ≈ `MAX_CONCURRENT_JOBS × 2 × CHUNK_SIZE_MB`. |
| `CHUNK_SIZE_MB` | 16 | Floored to a multiple of 256 KiB. Google recommends 8–32 MB. |
| `MAX_FILE_SIZE_BYTES` | 10 GiB | `0` disables. Enforced at probe time *and* on the byte stream. |
| `MAX_ACTIVE_JOBS_PER_USER` | 5 | Queued + transferring jobs one user may own. |
| `BANDWIDTH_LIMIT_BPS` | 0 | Per-job throttle. `0` = unlimited. |
| `LEASE_TTL_MS` | 60000 | How long a dead node holds a job before another steals it. |
| `ON_DUPLICATE` | rename | `rename` appends ` (1)`; `allow` lets Drive keep both. |
| `SSRF_EXTRA_BLOCKED_CIDRS` | – | Add ranges you never want fetched, e.g. a partner VPC. |

---

## 3. Deploy to one VPS

Requirements: Docker Engine 24+ with the compose plugin, 2 GB RAM, ports 80/443
open.

```bash
git clone <your-fork> remote-to-drive && cd remote-to-drive
cp .env.example .env
$EDITOR .env                       # set APP_URL, DOMAIN, ACME_EMAIL, secrets, Google creds
docker compose up -d --build
docker compose ps                  # migrate exits 0, everything else healthy
```

That starts:

| Service | Purpose |
| --- | --- |
| `postgres` | Shared state. **Not published to the host** — reachable only on the internal compose network. |
| `redis` | Queue, progress pub/sub, rate-limit counters. `noeviction` so queue data is never dropped. |
| `migrate` | One-shot `prisma migrate deploy`, runs before the app. |
| `app` | `ROLE=both` — HTTP API, UI and worker in one process, on `127.0.0.1:8080`. |
| `caddy` | Auto-HTTPS for `DOMAIN`, reverse proxy with SSE-friendly settings. |

Open `https://<your-domain>/`, sign in with Google, paste a URL, watch it
stream.

**No domain / no TLS?** Remove the `caddy` service and change the app port
mapping to `8080:8080`. Google will still require an `https` redirect URI for a
production OAuth client — `http` is only accepted for `localhost`.

Verify the deployment:

```bash
curl -fsS http://127.0.0.1:8080/healthz   # shallow: process is up
curl -fsS http://127.0.0.1:8080/readyz    # deep: Postgres + Redis reachable
```

---

## 4. Scale to multiple VPS

There are two independent scaling axes. Both are just "run the same image with a
different `ROLE`".

### Shared infrastructure first

Every node must reach the **same** Postgres and Redis. Two options:

- **Managed** (recommended): Cloud SQL / RDS + Memorystore / ElastiCache. Put
  the connection strings in every node's `.env`.
- **Self-hosted on its own VPS**: keep the `postgres` and `redis` services from
  `docker-compose.yml`, publish their ports, and firewall 5432/6379 to the exact
  IPs of your app and worker nodes. Never expose them to `0.0.0.0`.

```bash
DATABASE_URL=postgresql://r2d:PASSWORD@10.0.0.5:5432/r2d?schema=public&connection_limit=20
REDIS_URL=redis://10.0.0.5:6379
```

> `connection_limit` is **per process**. Total connections ≈
> `nodes × connection_limit`, which must stay under Postgres'
> `max_connections` (100 by default).

### Add worker nodes (more transfer capacity)

On each new VPS:

```bash
# 1. build once, push to a registry every node can pull from
docker build -t registry.example.com/remote-to-drive:1.0.0 .
docker push registry.example.com/remote-to-drive:1.0.0

# 2. on the worker VPS
scp docker-compose.worker.yml .env worker-vps:/opt/r2d/
ssh worker-vps
cd /opt/r2d
# edit .env: ROLE=worker, NODE_ID=vps-worker-01, shared DATABASE_URL/REDIS_URL,
#            identical SESSION_SECRET / TOKEN_ENCRYPTION_KEY / GOOGLE_*
docker compose -f docker-compose.worker.yml up -d
```

A worker node runs no public HTTP surface. It exposes `/healthz` on
`127.0.0.1:8081` for monitoring only. Raise `MAX_CONCURRENT_JOBS` to use bigger
machines; add more VPS to add more parallel transfers.

Because `NODE_ID` defaults to `<hostname>-<role>-<pid>`, set it explicitly — it
is what the admin page shows.

### Add web nodes (more API/UI capacity)

Same procedure with `docker-compose.web.yml` and `ROLE=web`. Web nodes are
completely stateless: sessions are signed cookies, rate limits live in Redis,
progress lives in Redis pub/sub. Any node can serve any request, so a plain
round-robin or least-conn balancer works with **no sticky sessions**.

Then add the node to the `upstream` block in `deploy/nginx/lb.conf`.

### Recommended shapes

| Traffic | Layout |
| --- | --- |
| Personal / small team | 1 VPS, `ROLE=both` |
| Growing | 1 web VPS + 1–3 worker VPS + managed Postgres/Redis |
| Larger | 2+ web VPS behind an LB + N worker VPS, `ROLE` split, one shared datastore |

Splitting web from worker is worth doing early: a transfer-heavy worker should
not be competing with API latency, and the two scale on different signals.

---

## 5. TLS and load balancing

### Caddy (single node, zero config)

`deploy/caddy/Caddyfile` is wired into `docker-compose.yml`. Set `DOMAIN` and
`ACME_EMAIL` and certificates are issued and renewed automatically. It already
sets `flush_interval -1` so SSE progress streams are not buffered.

### Nginx (multiple web nodes)

`deploy/nginx/lb.conf` is a complete config: HTTP→HTTPS redirect, an ACME
challenge root, TLS 1.2/1.3, least-conn upstream, and — critically — a separate
`location /api/events` block with buffering disabled.

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo cp deploy/nginx/lb.conf /etc/nginx/sites-available/r2d
sudo ln -s /etc/nginx/sites-available/r2d /etc/nginx/sites-enabled/r2d
$EDITOR /etc/nginx/sites-available/r2d          # node IPs, domain
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d drive.example.com
```

> **If progress events never arrive**, this is almost always proxy buffering.
> `/api/events` is a Server-Sent Events stream; it needs `proxy_buffering off`,
> `proxy_cache off` and a long `proxy_read_timeout`. The app also sends
> `x-accel-buffering: no`, which Nginx honours — but only if you have not
> overridden it. Set `TRUST_PROXY=true` on the app nodes so rate limits and
> audit logs see real client IPs.

Health checks for the balancer: use `/healthz` (cheap, no datastore access). Use
`/readyz` for deployment gates — it actually queries Postgres and Redis and
returns 503 when either is down.

---

## Operations

### Admin dashboard

`/admin.html` is visible only to addresses in `ADMIN_EMAILS`. It shows:

- every node, whether it is online (heartbeat within 45 s), and its active job count
- transfer slots busy vs. total across the fleet
- queue depth, in-flight and waiting counts, plus a **capacity warning** when
  waiting jobs exceed available slots
- 24 h throughput: completed, failed, bytes transferred
- stuck jobs (`TRANSFERRING` with an expired lease) — these are mid-recovery and
  normally clear within one reconciler interval
- the effective non-secret configuration

### Health endpoints

| Endpoint | Cost | Use for |
| --- | --- | --- |
| `GET /healthz` | none | Load-balancer and container health checks. Returns role, node id, version, uptime, active jobs. |
| `GET /readyz` | 1 SQL query + 1 Redis PING | Deploy gates and alerting. 503 with per-check latency when a dependency is down. |

### Logs

Structured JSON on stdout (`pino`). `Authorization`, `Cookie`, refresh tokens,
access tokens and session URIs are redacted at the logger level. Set
`LOG_LEVEL=debug` while diagnosing; in development the output is pretty-printed.

Every job also gets a `job_logs` trail (probe result, resume decisions, errors)
that the UI renders on the job card and the API returns from
`GET /api/jobs/:id`.

### Upgrading

```bash
docker pull registry.example.com/remote-to-drive:1.0.1
docker compose up -d            # or: docker compose -f docker-compose.worker.yml up -d
```

Migrations run in the entrypoint before the process starts. Shutdown is
graceful: the worker stops claiming new jobs, finishes or abandons the current
ones (leases are released), then HTTP drains, with a 20 s hard ceiling so a
wedged SSE stream cannot block a rolling deploy. Jobs interrupted by a restart
are recovered by the reconciler on another node.

### Backups

Back up Postgres. It holds the users, the encrypted refresh tokens and the full
job history — including the resumable-session URIs that make in-flight transfers
survivable. Redis is reconstructible: it carries the queue, rate-limit counters
and progress cache. Losing Redis costs you in-flight job delivery (the
reconciler re-enqueues them from Postgres) but no data.

---

## HTTP API

All endpoints are JSON. Mutating requests need the `x-csrf-token` header
matching the `r2d_csrf` cookie, and an authenticated session cookie.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/auth/google` | Start OAuth |
| `GET` | `/auth/google/callback` | OAuth redirect target |
| `POST` | `/auth/logout` | Clear the session |
| `GET` | `/api/csrf` | Fetch/refresh the CSRF token |
| `GET` | `/api/me` | Session, Drive connection state, effective limits |
| `GET` | `/api/drive/folders` | Folders the app may write to |
| `POST` | `/api/jobs` | Submit one URL or a batch → `202` with `batchId` |
| `GET` | `/api/jobs` | History, keyset-paginated, optional `status` filter |
| `GET` | `/api/jobs/:id` | One job plus its log trail |
| `POST` | `/api/jobs/:id/cancel` | Cancel a queued or running job |
| `POST` | `/api/jobs/:id/retry` | Retry a failed or cancelled job |
| `DELETE` | `/api/jobs/:id` | Cancel if active, then delete |
| `GET` | `/api/events` | SSE stream of live progress for the signed-in user |
| `GET` | `/api/admin/overview` | Admin-only fleet summary |
| `GET` | `/healthz`, `/readyz` | Health |

### Submitting a job

```bash
curl -X POST https://drive.example.com/api/jobs \
  -H 'content-type: application/json' \
  -H "x-csrf-token: $CSRF" \
  -b "r2d_session=$SESSION; r2d_csrf=$CSRF" \
  -d '{
        "items": [
          { "url": "https://example.com/big.iso", "fileName": "ubuntu.iso" },
          { "url": "https://example.com/other.zip", "folderId": "1AbCdEf" }
        ]
      }'
```

`202 Accepted`:

```json
{
  "batchId": "b_01J...",
  "accepted": [{ "id": "j_01J...", "url": "https://example.com/big.iso", "status": "QUEUED" }],
  "rejected": [{ "url": "http://10.0.0.5/x", "code": "SSRF_BLOCKED", "message": "…" }],
  "limits": { "maxActiveJobsPerUser": 5, "remaining": 3 }
}
```

Rejected URLs are reported per-URL, so one bad link never sinks a batch. The
shorthand `{ "url": "…" }` and `{ "urls": ["…"], "folderId": "…" }` are also
accepted.

### Progress events

```bash
curl -N https://drive.example.com/api/events
```

```
event: snapshot
data: [{"id":"j_01J…","status":"TRANSFERRING","progress":0.42,…}]

event: progress
data: {"jobId":"j_01J…","status":"TRANSFERRING","phase":"streaming",
       "transferredBytes":44040192,"totalBytes":104857600,"speedBps":8388608,
       "etaSeconds":7,"fileName":"ubuntu.iso","nodeId":"vps-worker-01"}
```

A `snapshot` arrives immediately so a client that reconnects mid-transfer is
correct without waiting for the next tick. `EventSource` reconnects on its own.

---

## Security model

**SSRF.** Only `http`/`https`, only ports in `ALLOWED_PORTS`, no credentials in
the URL. Every DNS record the hostname resolves to is checked against the
blocklist — accepting the first good one would let an attacker mix a public
A record with `169.254.169.254` and wait for us to pick it. The socket is then
**pinned to the vetted IP** via a custom `lookup`, which closes the
DNS-rebinding window between "we checked the name" and "we opened the socket".
Redirects are re-validated at every hop. Blocked ranges cover RFC1918, loopback,
link-local (including the cloud metadata endpoint), CGNAT, multicast, reserved
and documentation space, plus IPv6 ULA/link-local/NAT64 — and the IPv4 addresses
*embedded* in IPv4-mapped, 6to4 and Teredo forms.

**Secrets.** Only via environment variables; the process refuses to start
without them. Google refresh tokens and Drive session URIs (which is itself a
bearer credential for the upload) are sealed with AES-256-GCM, 12-byte IV,
16-byte tag, AAD binding the key version. Logs redact them.

**Sessions and CSRF.** Signed, `httpOnly`, `Secure`, `SameSite=Lax` cookies —
Lax is what lets the Google OAuth redirect land with the cookie attached while
still blocking cross-site POSTs. State-changing requests carry a double-submit
CSRF token compared in constant time. The CSRF cookie is deliberately *not*
`httpOnly`: the protection comes from a cross-origin attacker being unable to
read it.

**Input.** Every request body and query is validated with Zod. Filenames are
NFC-normalized, stripped of directory components in both `/` and `\` form,
cleared of control characters and the characters Drive rejects, and truncated to
200 characters.

**Abuse.** Fleet-wide rate limiting backed by Redis (with an in-memory store, N
web nodes would each allow the full quota, silently multiplying the cap), a much
tighter separate limit on job submission, per-user active-job caps, a maximum
file size enforced both at probe time and on the byte stream, and an optional
per-job bandwidth ceiling.

**Isolation.** `drive.file` scope only — the app cannot see files it did not
create. Containers run as a non-root user under `tini`. Postgres is not
published to the host.

**Terms.** The UI states, before submission, that users may only transfer files
they have the legal right to download and store, that copyrighted material they
do not own is prohibited, and that IPs and URLs are logged for abuse prevention.

---

## Development

```bash
npm install
cp .env.example .env             # then edit

# local Postgres + Redis only
docker compose up -d postgres redis

npm run db:push                  # push the schema without a migration
npm run dev                      # tsx watch, ROLE=both, pretty logs
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch mode, `src/index.ts` |
| `npm run build` | `prisma generate` + `tsc` into `dist/` |
| `npm start` | Run the built output |
| `npm run typecheck` | Both `tsconfig.json` and `tsconfig.test.json`, no emit |
| `npm test` | vitest |
| `npm run prisma:migrate` | Create a migration (needs `DATABASE_URL`) |
| `npm run prisma:deploy` | Apply migrations |

For local OAuth, set `APP_URL=http://localhost:8080` and add
`http://localhost:8080/auth/google/callback` as an authorized redirect URI.
Google allows `http` for `localhost` only.

The project is ESM (`"type": "module"` with `moduleResolution: NodeNext`), so
**every relative import must end in `.js`** even though the source is
TypeScript.

---

## Tests

```bash
npm test
```

| File | Covers |
| --- | --- |
| `test/ssrf.test.ts` | IP/CIDR parsing, the blocklist, embedded IPv4 in IPv6 transition forms, scheme/port/credential rejection, **every** DNS record being validated, IPv4 preference, the pinned lookup |
| `test/filename.test.ts` | `Content-Disposition` (RFC 6266 `filename*`, quoted with escapes, bare), traversal and control-character sanitizing, name precedence, extension inference, de-duplication |
| `test/chunking.test.ts` | 256 KiB alignment, exact reassembly from ragged reads, single short tail, buffer non-reuse, stream chaining and error propagation both ways, `Content-Range` construction, Drive error mapping, byte limiter, throttle, backoff |
| `test/driveUpload.test.ts` | The resumable protocol against a real HTTPS server that enforces contiguity and alignment: aligned chunked upload, wildcard totals, offset queries, resuming the tail, expired sessions, quota errors |
| `test/transferPipeline.test.ts` | `runTransfer` end to end against a real HTTP source: known and unknown lengths, renaming, size caps, resuming from Drive's offset, restarting when the source ignores `Range`, expired sessions, already-complete sessions, and re-syncing after a lost upload response |
| `test/jobRecovery.test.ts` | The resume decision table, lease acquisition/renewal/release, epoch fencing against a zombie owner, heartbeat loss aborting the transfer, DB blips being survivable, and reconciler recovery, exhaustion, re-entrancy and idempotency |

The Drive and pipeline tests use real sockets — a self-signed certificate is
generated with `openssl` at run time for the Drive endpoint (that suite skips
itself if `openssl` is unavailable), and the source server is plain HTTP on a
loopback port with the SSRF policy's test escape hatch enabled.

---

## Troubleshooting

**The process exits immediately at boot.** Config validation failed; the reason
is printed to stderr. Usually a missing `SESSION_SECRET`, or a
`TOKEN_ENCRYPTION_KEY` that is not exactly 32 bytes of hex.

**`redirect_uri_mismatch` from Google.** `GOOGLE_REDIRECT_URI` (or the derived
`${APP_URL}/auth/google/callback`) must match an entry in the OAuth client
*character for character* — scheme, host, port, path, no trailing slash.

**Sign-in works but Drive transfers fail with "Google rejected the stored
authorization."** The consent screen is still in *Testing* and the account is
not a test user, or the refresh token was revoked (test-user tokens expire
after 7 days). Add the account as a test user, or publish the app.

**No refresh token is stored.** Google only issues one on the first consent. The
app requests `prompt=consent` every time, but a user who revoked access in
[Google Account → Security → Third-party access](https://myaccount.google.com/permissions)
must re-grant it there.

**Progress bar never moves, but jobs complete.** SSE is being buffered. See
[Nginx](#nginx-multiple-web-nodes): `proxy_buffering off` on `/api/events`, and
`flush_interval -1` in Caddy.

**Jobs sit in `queued` and never start.** No worker is running, or workers
cannot reach Redis. Check `/readyz` on a worker node and
`docker compose logs app`. Also confirm `QUEUE_NAME` is identical everywhere.

**Jobs stuck in `transferring`.** The owning node died. This self-heals within
`LEASE_REAPER_INTERVAL_MS` + `LEASE_TTL_MS` (≈ 75 s by default); the admin page
lists them under *stuck*. If they persist, no worker is running the reconciler —
every worker node runs one.

**`DRIVE_SESSION_EXPIRED` on every retry.** Drive drops resumable sessions after
about a week of inactivity, or after certain errors. The worker detects this and
starts a fresh session automatically; if you see it repeatedly, check that
`TOKEN_ENCRYPTION_KEY` has not changed between nodes — a worker that cannot
decrypt the stored session URI falls back to a new session each time.

**`SSRF_BLOCKED` for a URL you know is public.** The hostname resolves to a
private address (a split-horizon DNS record, or an internal-only host). If you
genuinely need to allow it, add the range to `SSRF_EXTRA_ALLOWED_CIDRS` rather
than setting `SSRF_ALLOW_PRIVATE=true`.

**Transfers are slow.** Check `BANDWIDTH_LIMIT_BPS` (0 = unlimited), then
`MAX_CONCURRENT_JOBS` — a single job is bounded by one TCP stream to Google, so
throughput per node scales with concurrency, not with a bigger machine.

**Out of memory on a worker.** Memory is `MAX_CONCURRENT_JOBS × 2 ×
CHUNK_SIZE_MB`. Lower either value. A worker holding far more than that suggests
something is retaining chunk buffers — please open an issue with the job log.

**Postgres `too many connections`.** Total connections ≈ `nodes ×
connection_limit` from `DATABASE_URL`. Lower `connection_limit` per node or raise
`max_connections`.

**Rate limits feel wrong behind a proxy.** Set `TRUST_PROXY=true` so the app
reads `X-Forwarded-For`. Without it every request appears to come from the
balancer and shares one bucket.

---

## License

MIT — see [LICENSE](LICENSE).
# remote2drive
