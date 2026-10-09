import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { toNumber } from '../../db.js';
import type { AppContext } from '../context.js';
import { requireAdmin } from '../auth.js';
import { NodeRegistry } from '../../worker/registry.js';

export interface FleetOverview {
  nodes: Awaited<ReturnType<typeof NodeRegistry.list>>;
  queue: { waiting: number; active: number; delayed: number; failed: number; completed: number };
  jobs: Record<string, number>;
  throughput: { last24hCompleted: number; last24hFailed: number; bytesLast24h: number };
  stuck: Array<{ id: string; status: string; leaseOwner: string | null; leaseExpiresAt: string | null; queuedAt: string }>;
  config: Record<string, unknown>;
}

export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config, prisma, queue } = ctx;

  app.get('/api/admin/overview', async (request): Promise<FleetOverview> => {
    requireAdmin(request, config);

    const [nodes, counts, rawCounts, throughput, stuck] = await Promise.all([
      NodeRegistry.list(prisma),
      queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      prisma.job.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.job.aggregate({
        where: { finishedAt: { gte: new Date(Date.now() - 86_400_000) } },
        _count: { _all: true },
        _sum: { totalBytes: true },
      }),
      prisma.job.findMany({
        where: { status: 'TRANSFERRING', leaseExpiresAt: { lt: new Date() } },
        select: { id: true, status: true, leaseOwner: true, leaseExpiresAt: true, queuedAt: true },
        take: 25,
        orderBy: { leaseExpiresAt: 'asc' },
      }),
    ]);

    const completedByStatus = await prisma.job.count({
      where: { status: 'COMPLETED', finishedAt: { gte: new Date(Date.now() - 86_400_000) } },
    });
    const failedByStatus = await prisma.job.count({
      where: { status: 'FAILED', finishedAt: { gte: new Date(Date.now() - 86_400_000) } },
    });

    const jobs: Record<string, number> = {};
    for (const row of rawCounts) jobs[row.status] = row._count._all;

    return {
      nodes,
      queue: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
      },
      jobs,
      throughput: {
        last24hCompleted: completedByStatus,
        last24hFailed: failedByStatus,
        bytesLast24h: toNumber(throughput._sum.totalBytes ?? 0n),
      },
      stuck: stuck.map((row) => ({
        id: row.id,
        status: row.status,
        leaseOwner: row.leaseOwner,
        leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
        queuedAt: row.queuedAt.toISOString(),
      })),
      config: safeConfig(config),
    };
  });
}

/** Exposes only the operational knobs — never secrets — on the admin page. */
export function safeConfig(config: AppConfig): Record<string, unknown> {
  return {
    role: config.role,
    appVersion: config.appVersion,
    nodeId: config.nodeId,
    chunkSizeBytes: config.chunkSizeBytes,
    maxConcurrentJobs: config.maxConcurrentJobs,
    maxActiveJobsPerUser: config.maxActiveJobsPerUser,
    maxUrlsPerRequest: config.maxUrlsPerRequest,
    maxFileSizeBytes: config.maxFileSizeBytes,
    bandwidthLimitBps: config.bandwidthLimitBps,
    maxAttempts: config.maxAttempts,
    leaseTtlMs: config.leaseTtlMs,
    onDuplicate: config.onDuplicate,
    ssrfAllowPrivate: config.ssrfAllowPrivate,
    allowedPorts: config.allowedPorts,
  };
}
