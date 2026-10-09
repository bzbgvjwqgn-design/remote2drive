import type { PrismaClient } from '@prisma/client';
import { childLogger } from '../logger.js';

export interface NodeInfo {
  id: string;
  role: 'web' | 'worker' | 'both';
  hostname: string;
  version: string;
  concurrency: number;
}

export interface NodeView extends NodeInfo {
  activeJobs: number;
  queuedJobs: number;
  startedAt: Date;
  lastSeenAt: Date;
  online: boolean;
}

const STALE_AFTER_MS = 45_000;

/**
 * Liveness registry for the admin page. A node upserts itself on a heartbeat
 * and deletes its row on a clean shutdown; nodes that vanish (power loss,
 * OOM kill) simply stop being counted as online once their heartbeat ages out.
 */
export class NodeRegistry {
  private timer: NodeJS.Timeout | null = null;
  private activeJobs = 0;
  private readonly log = childLogger({ component: 'registry' });

  constructor(
    private readonly prisma: PrismaClient,
    private readonly info: NodeInfo,
    private readonly intervalMs = 15_000,
  ) {}

  async start(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => void this.beat(), this.intervalMs);
    this.timer.unref?.();
  }

  setActiveJobs(count: number): void {
    this.activeJobs = count;
  }

  private async beat(): Promise<void> {
    const now = new Date();
    try {
      await this.prisma.node.upsert({
        where: { id: this.info.id },
        create: {
          id: this.info.id,
          role: this.info.role,
          hostname: this.info.hostname,
          version: this.info.version,
          concurrency: this.info.concurrency,
          activeJobs: this.activeJobs,
          startedAt: now,
          lastSeenAt: now,
        },
        update: {
          role: this.info.role,
          hostname: this.info.hostname,
          version: this.info.version,
          concurrency: this.info.concurrency,
          activeJobs: this.activeJobs,
          lastSeenAt: now,
        },
      });
    } catch (error) {
      this.log.warn({ err: (error as Error).message }, 'node heartbeat failed');
    }
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await this.prisma.node.deleteMany({ where: { id: this.info.id } });
    } catch {
      // A missing row on shutdown is not an error worth surfacing.
    }
  }

  static async list(prisma: PrismaClient): Promise<NodeView[]> {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);
    const rows = await prisma.node.findMany({ orderBy: { id: 'asc' } });
    return rows.map((row) => ({
      id: row.id,
      role: row.role as NodeInfo['role'],
      hostname: row.hostname,
      version: row.version,
      concurrency: row.concurrency,
      activeJobs: row.activeJobs,
      queuedJobs: row.queuedJobs,
      startedAt: row.startedAt,
      lastSeenAt: row.lastSeenAt,
      online: row.lastSeenAt >= cutoff,
    }));
  }
}
