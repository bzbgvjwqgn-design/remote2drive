# Deployment guide

Step-by-step instructions for taking `remote-to-drive` from a fresh VPS to a
running, HTTPS-served fleet. Follow the sections in order; each one ends with a
check that tells you whether you can move on.

- [Part A — Deploy to a single VPS](#part-a--deploy-to-a-single-vps) (steps 1–9, ~20 minutes)
- [Part B — Scale to multiple VPS](#part-b--scale-to-multiple-vps) (steps 10–14)
- [Part C — Day-2 operations](#part-c--day-2-operations) (upgrade, rollback, backups, monitoring)
- [Troubleshooting](#troubleshooting)

Architecture, API reference and the security model live in
[README.md](README.md). This file is only about getting it deployed.

---

## Part A — Deploy to a single VPS

### Step 1 — Check the prerequisites

| Requirement | Minimum |
| --- | --- |
| VPS | 2 GB RAM, 2 vCPU, 20 GB disk (the app stores no file data on disk) |
| OS | Any Linux with Docker; commands below assume Debian/Ubuntu |
| Docker | Engine 24+ **with the compose plugin** (`docker compose`, not `docker-compose`) |
| Domain | One A/AAAA record you control, pointing at this VPS |
| Firewall | Inbound 80 and 443 open; 22 restricted to your IP |

```bash
docker --version && docker compose version
```

Both must print a version. If `docker compose version` fails:

```bash
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"   # then log out and back in
```

✔ **Check:** `docker compose version` prints v2.x.

---

### Step 2 — Point your domain at the VPS

Create an A record for `drive.example.com` → your VPS public IP. Caddy cannot
issue a certificate until DNS resolves to this machine, and Google will reject an
OAuth redirect URI whose host does not resolve.

```bash
dig +short drive.example.com     # must print your VPS IP
```

✔ **Check:** `dig +short` returns the VPS public IP.

---

### Step 3 — Create the Google OAuth client

1. <https://console.cloud.google.com/> → create or select a project.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen**
   - User type **External** (or **Internal** if you have Google Workspace and
     only your own domain will use this — Internal skips Google's review).
   - App name, support email, developer email.
   - **Scopes → Add or remove scopes** → add exactly
     `https://www.googleapis.com/auth/drive.file` plus `openid`, `email`,
     `profile`.
   - **Test users** → add every account that will sign in while the app is in
     *Testing*.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://drive.example.com`
   - Authorized redirect URIs: `https://drive.example.com/auth/google/callback`
5. Copy the **Client ID** and **Client secret** somewhere safe — you need them in
   step 5.

The redirect URI must match `GOOGLE_REDIRECT_URI` (or the value derived from
`APP_URL`) **character for character**: scheme, host, port, path, no trailing
slash.

✔ **Check:** you have a Client ID ending in `.apps.googleusercontent.com` and a
Client secret starting with `GOCSPX-`.

---

### Step 4 — Get the code onto the VPS

```bash
sudo mkdir -p /opt/remote-to-drive && sudo chown "$USER" /opt/remote-to-drive
git clone <your-repo-url> /opt/remote-to-drive
cd /opt/remote-to-drive
```

No `git` remote? Copy the tree instead — the build needs nothing outside the
project directory:

```bash
rsync -av --exclude node_modules --exclude .env ./ vps:/opt/remote-to-drive/
```

✔ **Check:** `ls Dockerfile docker-compose.yml .env.example prisma/migrations`
succeeds. `prisma/migrations/0_init/` must be present — the `migrate` service
runs `prisma migrate deploy`, which needs it.

---

### Step 5 — Write `.env`

```bash
cp .env.example .env
chmod 600 .env            # it holds the OAuth secret and both signing keys
```

Generate the two secrets:

```bash
openssl rand -base64 48                                          # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # TOKEN_ENCRYPTION_KEY
```

No Node on the host? Use openssl for both:

```bash
openssl rand -base64 48        # SESSION_SECRET
openssl rand -hex 32           # TOKEN_ENCRYPTION_KEY (64 hex chars = 32 bytes)
```

Edit `.env` and set at least these:

```bash
ROLE=both
NODE_ENV=production
APP_URL=https://drive.example.com
DOMAIN=drive.example.com
ACME_EMAIL=you@example.com
ADMIN_EMAILS=you@example.com

SESSION_SECRET=<openssl rand -base64 48>
TOKEN_ENCRYPTION_KEY=<64 hex chars>

GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxx
GOOGLE_REDIRECT_URI=                       # empty = derive from APP_URL

# Leave these two at their compose defaults for a single VPS:
DATABASE_URL=postgresql://r2d:r2d@postgres:5432/r2d?schema=public&connection_limit=20
REDIS_URL=redis://redis:6379
```

Three rules that cause almost every broken multi-node deployment:

1. `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` must be **byte-identical on every
   node**. A worker that cannot decrypt the stored session URI silently starts a
   fresh upload instead of resuming.
2. `TOKEN_ENCRYPTION_KEY` is **not rotatable** without invalidating every stored
   Google refresh token — all users would have to reconnect Drive.
3. `POSTGRES_PASSWORD` defaults to `r2d`. Change it (and `DATABASE_URL` to
   match) if this box is reachable from anywhere.

Everything else has a working default; the full annotated list is in
[`.env.example`](.env.example). The process **refuses to boot** on a missing or
malformed value and prints exactly which one.

> `docker-compose.yml` forwards each variable explicitly, so the two compose
> files in Part B use `env_file: .env` and pass everything through, while the
> single-node file maps a fixed list. Use `CHUNK_SIZE_MB` (not
> `CHUNK_SIZE_BYTES`) — it is the documented knob and is forwarded everywhere.

✔ **Check:** `grep -c . .env` is non-zero and `.env` is mode 600.

---

### Step 6 — Build and start the stack

```bash
cd /opt/remote-to-drive
docker compose up -d --build
```

First build takes 2–4 minutes. This starts five services:

| Service | Role | Notes |
| --- | --- | --- |
| `postgres` | Shared state | **Not published to the host** — internal compose network only |
| `redis` | Queue, progress pub/sub, rate limits | `noeviction`, so queue data is never evicted |
| `migrate` | One-shot `prisma migrate deploy` | Exits 0; `app` waits for it |
| `app` | `ROLE=both` — API + UI + worker | Listens on `127.0.0.1:8080` |
| `caddy` | Auto-HTTPS reverse proxy | Publishes 80/443, issues the cert for `DOMAIN` |

```bash
docker compose ps
```

✔ **Check:** `migrate` shows `Exited (0)`; `postgres`, `redis`, `app`, `caddy`
all show `running (healthy)`. If not, jump to
[Troubleshooting](#troubleshooting) with `docker compose logs <service>`.

---

### Step 7 — Verify health

```bash
curl -fsS http://127.0.0.1:8080/healthz    # process up, no datastore access
curl -fsS http://127.0.0.1:8080/readyz     # Postgres query + Redis PING
```

`/readyz` returning 200 means the app can reach both datastores. Then check the
public side, which also proves the certificate was issued:

```bash
curl -fsSI https://drive.example.com/healthz
```

✔ **Check:** both return `200`. A certificate error here means DNS was not
resolving at step 6 — `docker compose logs caddy` shows the ACME error; fix DNS
and `docker compose restart caddy`.

---

### Step 8 — First sign-in and transfer

1. Open `https://drive.example.com/`.
2. **Sign in with Google** → choose the account you added as a test user →
   accept the `drive.file` consent.
3. Pick a destination folder (optional — empty means Drive root).
4. Paste a URL and submit. A small public file is the right first test, e.g.
   `https://speed.hetzner.de/100MB.bin`.
5. Watch the progress bar move, then confirm the file appears in your Drive.

Then load `https://drive.example.com/admin.html`. You should see this node
listed as online with its active-job count.

✔ **Check:** a job reaches `completed`, the file is in Drive, and the admin page
shows one online node.

---

### Step 9 — Set up automatic restarts

Compose already sets `restart: unless-stopped`, so the stack survives a reboot
as long as the Docker daemon starts on boot:

```bash
sudo systemctl enable docker
```

Back up Postgres now, before there is data you care about — see
[Backups](#backups).

✔ **Part A complete.** You have a working single-node deployment.

---

## Part B — Scale to multiple VPS

Every node runs the same image; `ROLE` decides what it does (`web`, `worker`, or
`both`). All state lives in Postgres and Redis, so a node holds nothing local —
any worker can pick up any job, including one whose original node died.

### Step 10 — Make Postgres and Redis shared

Two options. Pick one before adding any node.

**Option 1 — Managed (recommended).** Cloud SQL / RDS for Postgres, Memorystore
/ ElastiCache for Redis. Enable TLS, create a dedicated user, and put the
connection strings in every node's `.env`:

```bash
DATABASE_URL=postgresql://r2d:STRONG_PASSWORD@10.0.0.5:5432/r2d?schema=public&connection_limit=20
REDIS_URL=redis://10.0.0.5:6379
```

Drop the `postgres` and `redis` services from the primary's compose file (or
leave them running and unused), then run the migration once against the new
database:

```bash
docker compose run --rm migrate
```

**Option 2 — Self-hosted on the primary VPS.** Publish the two ports on the
**private** interface only and firewall them to your node IPs. In
`docker-compose.yml`:

```yaml
  postgres:
    ports:
      - "10.0.0.5:5432:5432"     # the primary's private IP, never 0.0.0.0
  redis:
    ports:
      - "10.0.0.5:6379:6379"
```

```bash
sudo ufw allow from 10.0.0.11 to any port 5432 proto tcp
sudo ufw allow from 10.0.0.11 to any port 6379 proto tcp
docker compose up -d postgres redis
```

Repeat the two `ufw` lines for every node IP you add. Redis has no password in
this compose file, so the firewall is the only thing between it and the network.

> **Connection math.** `connection_limit` in `DATABASE_URL` is **per process**.
> Total ≈ `nodes × connection_limit` and must stay under Postgres'
> `max_connections` (100 by default). With 6 nodes use `connection_limit=12`.

✔ **Check:** from a *different* VPS, `nc -vz 10.0.0.5 5432` and
`nc -vz 10.0.0.5 6379` both succeed — and from the public internet they both fail.

---

### Step 11 — Publish the image to a registry

Building on every node works but drifts. Build once, push, and have nodes pull:

```bash
cd /opt/remote-to-drive
docker build -t registry.example.com/remote-to-drive:1.0.0 .
docker login registry.example.com
docker push registry.example.com/remote-to-drive:1.0.0
```

Any OCI registry works — GHCR, Docker Hub, ECR, or a private one. Tag with the
version, not `latest`: rolling back is then a one-line change.

✔ **Check:** the tag is visible in the registry UI.

---

### Step 12 — Add a worker node

On the new VPS, as a non-root user:

```bash
sudo mkdir -p /opt/r2d && sudo chown "$USER" /opt/r2d
cd /opt/r2d

# Pull-from-registry: the compose file is all you need, because the image is
# already local by the time compose looks for it.
scp primary-vps:/opt/remote-to-drive/docker-compose.worker.yml .

# Build-on-node instead: copy the whole repo (Dockerfile, src/, prisma/,
# public/, package*.json) and add --build to the up command below.
```

Create `.env` for this node:

```bash
chmod 600 .env
cat > .env <<'EOF'
ROLE=worker
NODE_ENV=production
NODE_ID=vps-worker-02
APP_URL=https://drive.example.com
ADMIN_EMAILS=you@example.com

# identical to every other node
SESSION_SECRET=<same value>
TOKEN_ENCRYPTION_KEY=<same value>
GOOGLE_CLIENT_ID=<same value>
GOOGLE_CLIENT_SECRET=<same value>

# shared datastores
DATABASE_URL=postgresql://r2d:STRONG_PASSWORD@10.0.0.5:5432/r2d?schema=public&connection_limit=12
REDIS_URL=redis://10.0.0.5:6379
QUEUE_NAME=transfer

MAX_CONCURRENT_JOBS=4
EOF
```

Pull and start:

```bash
export IMAGE=registry.example.com/remote-to-drive:1.0.0
docker pull "$IMAGE"
docker compose -f docker-compose.worker.yml up -d
docker compose -f docker-compose.worker.yml logs -f worker
```

`NODE_ID` matters: it defaults to `<hostname>-<role>-<pid>` and is the name shown
on the admin page and written into job logs. Set it explicitly per machine.

Sizing: RAM ≈ `MAX_CONCURRENT_JOBS × 2 × CHUNK_SIZE_MB` plus ~200 MB overhead, so
the default (4 × 16 MB) is comfortable in 1 GB. Throughput per node scales with
concurrency, not with a bigger machine — a single job is one TCP stream to
Google.

A worker node runs no public HTTP surface. It binds `/healthz` to
`127.0.0.1:8081` for local monitoring only; do not expose it.

✔ **Check:** submit a job from the web UI and confirm the admin page shows it
running on `vps-worker-02`.

---

### Step 13 — Add a web node

Same procedure with `docker-compose.web.yml` and `ROLE=web`:

```bash
cd /opt/r2d
scp primary-vps:/opt/remote-to-drive/docker-compose.web.yml .
# .env as in step 12, but ROLE=web and NODE_ID=vps-web-02

export IMAGE=registry.example.com/remote-to-drive:1.0.0
docker pull "$IMAGE"
docker compose -f docker-compose.web.yml up -d
curl -fsS http://127.0.0.1:8080/readyz
```

Web nodes are fully stateless — signed session cookies, rate limits in Redis,
progress in Redis pub/sub — so **no sticky sessions** are needed.

**One networking detail:** `docker-compose.web.yml` publishes
`127.0.0.1:8080:8080`, which a load balancer on another machine cannot reach.
Change the mapping to the node's private IP and firewall it to the LB:

```yaml
    ports:
      - "10.0.0.11:8080:8080"
```

```bash
sudo ufw allow from 10.0.0.99 to any port 8080 proto tcp   # the LB's IP
```

If your load balancer runs on the same machine, leave the loopback binding as is.

✔ **Check:** `curl -fsS http://10.0.0.11:8080/readyz` succeeds from the LB host.

---

### Step 14 — Put a load balancer in front

**Caddy (simplest).** `deploy/caddy/Caddyfile` already issues and renews
certificates and sets `flush_interval -1` for SSE. To balance several web nodes,
replace the `reverse_proxy app:8080` line with the list form that is commented
out in that file:

```caddyfile
reverse_proxy 10.0.0.11:8080 10.0.0.12:8080 {
    lb_policy round_robin
    health_uri /healthz
    health_interval 10s
    fail_duration 30s
    flush_interval -1
}
```

**Nginx.** `deploy/nginx/lb.conf` is a complete config: HTTP→HTTPS redirect,
ACME challenge root, TLS 1.2/1.3, `least_conn` upstream, and a separate
`/api/events` block with buffering disabled.

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx/lb.conf /etc/nginx/sites-available/remote-to-drive
sudo ln -s /etc/nginx/sites-available/remote-to-drive /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
$EDITOR /etc/nginx/sites-available/remote-to-drive    # node IPs + domain
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d drive.example.com
```

Set `TRUST_PROXY=true` on every app node (the compose files already do) so rate
limits and audit logs see real client IPs instead of the balancer.

Health-check policy: use `/healthz` for the balancer (free, no datastore access)
and `/readyz` for deploy gates and alerting (it actually queries Postgres and
Redis and returns 503 when either is down).

> **If the progress bar never moves but jobs still complete**, it is proxy
> buffering. `/api/events` is a Server-Sent Events stream and needs
> `proxy_buffering off`, `proxy_cache off` and a long `proxy_read_timeout`
> (Nginx), or `flush_interval -1` (Caddy).

✔ **Check:** `curl -N https://drive.example.com/api/events` (authenticated)
streams a `snapshot` event immediately, and the admin page lists every web and
worker node as online.

### Recommended fleet shapes

| Traffic | Layout |
| --- | --- |
| Personal / small team | 1 VPS, `ROLE=both` (Part A only) |
| Growing | 1 web VPS + 1–3 worker VPS + managed Postgres/Redis |
| Larger | 2+ web VPS behind an LB + N worker VPS, shared datastore |

Splitting web from worker is worth doing early: a transfer-heavy worker should
not compete with API latency, and the two scale on different signals.

---

## Part C — Day-2 operations

### Upgrade

```bash
docker pull registry.example.com/remote-to-drive:1.0.1
cd /opt/r2d
IMAGE=registry.example.com/remote-to-drive:1.0.1 docker compose -f docker-compose.worker.yml up -d
```

Roll workers one at a time. Migrations run in the entrypoint before the process
starts, so apply them once (via the `migrate` service) before upgrading nodes.

Shutdown is graceful: the worker stops claiming new jobs, finishes or abandons
the current ones and releases their leases, then HTTP drains — with a 20 s hard
ceiling so a wedged SSE stream cannot block a rolling deploy. Jobs interrupted by
a restart are recovered by the reconciler on another node within ~75 s.

### Rollback

Because you tagged versions in step 11, rolling back is pointing `IMAGE` at the
previous tag and re-running `up -d`. Migrations are forward-only; if a release
added a migration, restore Postgres from the pre-upgrade backup instead.

### Backups

Back up **Postgres**. It holds the users, the AES-256-GCM-sealed refresh tokens
and the full job history, including the resumable-session URIs that make
in-flight transfers survivable.

```bash
docker compose exec -T postgres pg_dump -U r2d -Fc r2d > backup-$(date +%F).dump
# restore: pg_restore -U r2d -d r2d --clean backup-2026-10-09.dump
```

Redis is reconstructible: it carries the queue, rate-limit counters and progress
cache. Losing Redis costs in-flight job *delivery*, not data — the reconciler
re-enqueues from Postgres.

Back up `.env` separately, in a secrets manager. Without
`TOKEN_ENCRYPTION_KEY`, a restored database is full of tokens nobody can decrypt.

### Monitoring

| What | Where |
| --- | --- |
| Fleet overview, node load, queue depth, stuck jobs, 24 h throughput | `/admin.html` (requires an email in `ADMIN_EMAILS`) |
| Liveness for the balancer | `GET /healthz` |
| Dependency readiness for alerting | `GET /readyz` → 503 with per-check latency |
| Logs | Structured JSON on stdout (`pino`), secrets redacted. `docker compose logs -f app` |
| Per-job trail | `job_logs`, rendered on the job card and returned by `GET /api/jobs/:id` |

Alert on: `/readyz` failing, queue depth growing while worker slots are free, and
stuck jobs persisting longer than a few reconciler intervals.

Set `LOG_LEVEL=debug` while diagnosing; it is noisy.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Container exits immediately at boot | Config validation failed; the reason is on stderr. Usually a missing `SESSION_SECRET` or a `TOKEN_ENCRYPTION_KEY` that is not exactly 64 hex chars. `docker compose logs app` |
| `migrate` service exits non-zero | `prisma/migrations/` was not copied to the VPS, or `DATABASE_URL` is wrong. `docker compose logs migrate` |
| Caddy loops on certificate errors | DNS did not point at this box when it started, or 80/443 are firewalled. Fix, then `docker compose restart caddy` |
| `redirect_uri_mismatch` from Google | The console entry must equal `${APP_URL}/auth/google/callback` exactly — scheme, host, port, path, no trailing slash |
| Sign-in works, transfers say "Google rejected the stored authorization" | Consent screen still in *Testing* and the account is not a test user, or the token was revoked (test-user tokens expire after 7 days) |
| Jobs sit in `queued` forever | No worker running, workers cannot reach Redis, or `QUEUE_NAME` differs between nodes. Check `/readyz` on a worker and `docker compose logs worker` |
| Jobs stuck in `transferring` | The owning node died. Self-heals in `LEASE_REAPER_INTERVAL_MS + LEASE_TTL_MS` (~75 s). If it persists, no node is running the reconciler — every worker node runs one |
| `DRIVE_SESSION_EXPIRED` on every retry | `TOKEN_ENCRYPTION_KEY` differs between nodes, so the worker cannot decrypt the stored session URI and starts fresh each time |
| Progress bar frozen, jobs still complete | Proxy buffering on `/api/events`. See [step 14](#step-14--put-a-load-balancer-in-front) |
| `SSRF_BLOCKED` for a genuinely public URL | The hostname resolves to a private address (split-horizon DNS). Add the range to `SSRF_EXTRA_ALLOWED_CIDRS`, not `SSRF_ALLOW_PRIVATE=true` |
| Worker OOM-killed | Memory is `MAX_CONCURRENT_JOBS × 2 × CHUNK_SIZE_MB`. Lower either value |
| Postgres `too many connections` | `nodes × connection_limit` exceeded `max_connections`. Lower `connection_limit` per node |
| Rate limits behave oddly behind a proxy | `TRUST_PROXY=true` must be set, or every request looks like it comes from the balancer and shares one bucket |
| A new node never appears on `/admin.html` | It cannot reach Postgres (the registry writes its heartbeat there), or `NODE_ID` collides with another node |

More detail on each of these, and on how the transfer and failover machinery
works, is in [README.md](README.md).
