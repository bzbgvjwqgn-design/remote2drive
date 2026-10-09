import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { childLogger } from '../logger.js';
import { enqueueTransfer, type TransferJobData } from '../lib/queue.js';
import type { AppConfig } from '../config.js';

export interface ReconcileResult {
  recovered: number;
  enqueued: number;
  exhausted: number;
}

/**
 * Closes the gap between "a node died" and "the job runs again".
 *
 * Every worker node runs this on an interval. It is safe to run concurrently
 * on many nodes: state transitions are guarded inside the UPDATE's WHERE
 * clause, and queue inserts are deduplicated by a deterministic BullMQ job id.
 */
export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly log = childLogger({ component: 'reconciler' });

  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: Queue<TransferJobData>,
    private readonly config: Pick<AppConfig, 'maxAttempts' | 'leaseReaperIntervalMs' | 'retryBaseDelayMs' | 'retryMaxDelayMs'>,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.config.leaseReaperIntervalMs);
    this.timer.unref?.();
    // Run once immediately so a freshly booted fleet picks up orphans fast.
    void this.tick();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<ReconcileResult> {
    // Re-entrancy guard: a slow tick must not overlap the next one.
    if (this.running) return { recovered: 0, enqueued: 0, exhausted: 0 };
    this.running = true;
    try {
      const recovered = await this.recoverDeadLeases();
      const enqueued = await this.enqueueDueJobs();
      return { recovered, enqueued, exhausted: 0 };
    } catch (error) {
      this.log.error({ err: (error as Error).message }, 'reconcile tick failed');
      return { recovered: 0, enqueued: 0, exhausted: 0 };
    } finally {
      this.running = false;
    }
  }

  /** Jobs still marked TRANSFERRING whose owner stopped renewing its lease. */
  private async recoverDeadLeases(): Promise<number> {
    const now = new Date();
    const stale = await this.prisma.job.findMany({
      where: { status: 'TRANSFERRING', leaseExpiresAt: { lt: now } },
      select: { id: true, attempts: true, leaseOwner: true, userId: true },
      take: 100,
      orderBy: { leaseExpiresAt: 'asc' },
    });
    if (stale.length === 0) return 0;

    let recovered = 0;
    for (const job of stale) {
      const attempts = job.attempts + 1;
      const exhausted = attempts >= this.config.maxAttempts;

      // The WHERE clause repeats the lease-expiry condition so that a node
      // which wakes up and renews between our SELECT and this UPDATE simply
      // matches zero rows instead of being stolen mid-flight.
      const result = await this.prisma.job.updateMany({
        where: { id: job.id, status: 'TRANSFERRING', leaseExpiresAt: { lt: now } },
        data: {
          status: exhausted ? 'FAILED' : 'QUEUED',
          phase: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          attempts,
          errorCode: exhausted ? 'MAX_ATTEMPTS' : 'NODE_LOST',
          errorMessage: exhausted
            ? `Node ${job.leaseOwner ?? 'unknown'} died repeatedly; giving up after ${attempts} attempts`
            : `Node ${job.leaseOwner ?? 'unknown'} stopped heartbeating; job will resume elsewhere`,
          nextAttemptAt: exhausted ? null : new Date(),
        },
      });

      if (result.count === 0) continue;
      recovered += 1;

      await this.prisma.jobLog.create({
        data: {
          jobId: job.id,
          level: exhausted ? 'error' : 'warn',
          event: exhausted ? 'attempts_exhausted' : 'node_lost',
          message: `lease held by ${job.leaseOwner ?? 'unknown'} expired`,
        },
      });

      if (!exhausted) {
        await enqueueTransfer(this.queue, { jobId: job.id, userId: job.userId, attempt: attempts });
      }
      this.log.warn({ jobId: job.id, from: job.leaseOwner, attempts }, 'recovered job from dead node');
    }
    return recovered;
  }

  /** Queue everything that is due: brand new jobs and retries whose delay elapsed. */
  private async enqueueDueJobs(): Promise<number> {
    const now = new Date();
    const due = await this.prisma.job.findMany({
      where: {
        status: 'QUEUED',
        AND: [
          { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          {
            OR: [
              { leaseOwner: null },
              { leaseExpiresAt: null },
              { leaseExpiresAt: { lt: now } },
            ],
          },
        ],
      },
      select: { id: true, userId: true, attempts: true },
      take: 200,
      orderBy: { queuedAt: 'asc' },
    });

    let enqueued = 0;
    for (const job of due) {
      const ok = await enqueueTransfer(this.queue, {
        jobId: job.id,
        userId: job.userId,
        attempt: job.attempts,
      });
      if (ok) enqueued += 1;
    }
    return enqueued;
  }
}
