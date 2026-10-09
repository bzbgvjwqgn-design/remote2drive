import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config.js';
import { logger } from '../../logger.js';

export interface HealthDeps {
  config: AppConfig;
  prisma: PrismaClient;
  redis: Redis;
  startedAt: number;
  role: string;
  activeJobs?: () => number;
}

/**
 * `/healthz` is intentionally shallow — load balancers and orchestrators poll
 * it constantly, so it must not touch Postgres or Redis. `/readyz` performs the
 * real dependency checks and is what you point a deploy gate at.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/healthz', async () => ({
    ok: true,
    role: deps.role,
    nodeId: deps.config.nodeId,
    version: deps.config.appVersion,
    uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
    activeJobs: deps.activeJobs?.() ?? 0,
  }));

  app.get('/readyz', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};

    const dbStart = Date.now();
    try {
      await deps.prisma.$queryRaw`SELECT 1`;
      checks.database = { ok: true, latencyMs: Date.now() - dbStart };
    } catch (error) {
      checks.database = { ok: false, latencyMs: Date.now() - dbStart, error: (error as Error).message };
    }

    const redisStart = Date.now();
    try {
      const pong = await deps.redis.ping();
      checks.redis = { ok: pong === 'PONG', latencyMs: Date.now() - redisStart };
    } catch (error) {
      checks.redis = { ok: false, latencyMs: Date.now() - redisStart, error: (error as Error).message };
    }

    const ok = Object.values(checks).every((check) => check.ok);
    reply.status(ok ? 200 : 503);
    return { ok, role: deps.role, nodeId: deps.config.nodeId, checks };
  });
}

/**
 * Worker-only nodes still expose /healthz so the Docker HEALTHCHECK, an
 * orchestrator, and your uptime monitor all have something real to probe.
 */
export async function startHealthServer(deps: HealthDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger().child({ component: 'health-server' }) as unknown as FastifyBaseLogger,
    disableRequestLogging: true,
  });
  registerHealthRoutes(app, deps);
  await app.listen({ host: deps.config.host, port: deps.config.port });
  return app;
}
