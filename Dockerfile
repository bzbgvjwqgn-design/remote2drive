# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: full dependency install + Prisma client generation
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci || npm install
RUN npx prisma generate

# ---------------------------------------------------------------------------
# Stage 2: compile TypeScript
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:tsc

# ---------------------------------------------------------------------------
# Stage 3: production-only dependency tree, with the generated Prisma client
#          grafted back in (npm ci would otherwise discard it).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS proddeps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# ---------------------------------------------------------------------------
# Stage 4: runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 app \
 && useradd --system --uid 1001 --gid app --home /app app

WORKDIR /app
ENV NODE_ENV=production \
    ROLE=both \
    HOST=0.0.0.0 \
    PORT=8080

COPY --from=proddeps --chown=app:app /app/node_modules ./node_modules
# Prisma CLI is kept so `migrate deploy` can run from the entrypoint.
COPY --from=deps --chown=app:app /app/node_modules/prisma ./node_modules/prisma
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app public ./public
COPY --chown=app:app docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER app
EXPOSE 8080

# Worker-only nodes expose no HTTP port, so they report healthy unconditionally.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const r=(process.env.ROLE||'both');if(r==='worker'){process.exit(0)}const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/healthz').then(x=>process.exit(x.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "./entrypoint.sh"]
