import { Prisma, type PrismaClient } from '@prisma/client';
import { childLogger } from '../logger.js';

export interface ExpiredLease {
  jobId: string;
  status: string;
  leaseOwner: string | null;
  leaseEpoch: number;
}

/**
 * Ownership of a job across the fleet.
 *
 * BullMQ alone cannot guarantee single execution: a node that is merely slow
 * (GC pause, network stall, overloaded disk) can outlive its queue lock while
 * still being alive and still writing to the Drive upload session. Two writers
 * on one resumable session corrupt the file. Postgres gives us a lease that
 * every node can see, plus a monotonically increasing epoch that acts as a
 * fencing token — a zombie's writes are rejected once someone else has taken
 * over.
 */
export interface LeaseStore {
  /** Returns the new epoch, or null when another live owner holds the job. */
  tryAcquire(jobId: string, ownerId: string, ttlMs: number): Promise<number | null>;
  /** False means this node no longer owns the job and must stop immediately. */
  renew(jobId: string, ownerId: string, epoch: number, ttlMs: number): Promise<boolean>;
  release(jobId: string, ownerId: string, epoch: number): Promise<boolean>;
  findExpired(limit: number): Promise<ExpiredLease[]>;
}

export class PrismaLeaseStore implements LeaseStore {
  constructor(private readonly prisma: PrismaClient) {}

  async tryAcquire(jobId: string, ownerId: string, ttlMs: number): Promise<number | null> {
    const expiry = new Date(Date.now() + ttlMs);
    const now = new Date();
    // One atomic statement: Postgres row locking means a losing racer simply
    // matches zero rows rather than needing an explicit SELECT ... FOR UPDATE.
    const rows = await this.prisma.$queryRaw<Array<{ leaseEpoch: number }>>(Prisma.sql`
      UPDATE jobs
         SET lease_owner = ${ownerId},
             lease_expires_at = ${expiry},
             lease_epoch = lease_epoch + 1
       WHERE id = ${jobId}
         AND (
               lease_owner IS NULL
            OR lease_owner = ${ownerId}
            OR lease_expires_at IS NULL
            OR lease_expires_at < ${now}
         )
      RETURNING lease_epoch AS "leaseEpoch"
    `);
    const row = rows[0];
    return row === undefined ? null : Number(row.leaseEpoch);
  }

  async renew(jobId: string, ownerId: string, epoch: number, ttlMs: number): Promise<boolean> {
    const expiry = new Date(Date.now() + ttlMs);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE jobs
         SET lease_expires_at = ${expiry}
       WHERE id = ${jobId}
         AND lease_owner = ${ownerId}
         AND lease_epoch = ${epoch}
      RETURNING id
    `);
    return rows.length > 0;
  }

  async release(jobId: string, ownerId: string, epoch: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE jobs
         SET lease_owner = NULL,
             lease_expires_at = NULL
       WHERE id = ${jobId}
         AND lease_owner = ${ownerId}
         AND lease_epoch = ${epoch}
      RETURNING id
    `);
    return rows.length > 0;
  }

  async findExpired(limit: number): Promise<ExpiredLease[]> {
    const now = new Date();
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; status: string; leaseOwner: string | null; leaseEpoch: number }>
    >(Prisma.sql`
      SELECT id,
             status::text AS "status",
             lease_owner AS "leaseOwner",
             lease_epoch AS "leaseEpoch"
        FROM jobs
       WHERE lease_owner IS NOT NULL
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < ${now}
       ORDER BY lease_expires_at ASC
       LIMIT ${limit}
    `);
    return rows.map((row) => ({
      jobId: row.id,
      status: row.status,
      leaseOwner: row.leaseOwner,
      leaseEpoch: Number(row.leaseEpoch),
    }));
  }
}

/** Deterministic in-memory store used by the recovery tests. */
export class InMemoryLeaseStore implements LeaseStore {
  private readonly rows = new Map<
    string,
    { owner: string | null; expiresAt: number | null; epoch: number; status: string }
  >();

  seed(jobId: string, init: { owner?: string | null; expiresAt?: number | null; epoch?: number; status?: string } = {}): void {
    this.rows.set(jobId, {
      owner: init.owner ?? null,
      expiresAt: init.expiresAt ?? null,
      epoch: init.epoch ?? 0,
      status: init.status ?? 'QUEUED',
    });
  }

  inspect(jobId: string): { owner: string | null; expiresAt: number | null; epoch: number; status: string } | undefined {
    return this.rows.get(jobId);
  }

  setStatus(jobId: string, status: string): void {
    const row = this.rows.get(jobId);
    if (row !== undefined) row.status = status;
  }

  async tryAcquire(jobId: string, ownerId: string, ttlMs: number): Promise<number | null> {
    const row = this.rows.get(jobId);
    if (row === undefined) return null;
    const now = Date.now();
    const held =
      row.owner !== null && row.owner !== ownerId && (row.expiresAt === null || row.expiresAt >= now);
    if (held) return null;
    row.owner = ownerId;
    row.expiresAt = now + ttlMs;
    row.epoch += 1;
    return row.epoch;
  }

  async renew(jobId: string, ownerId: string, epoch: number, ttlMs: number): Promise<boolean> {
    const row = this.rows.get(jobId);
    if (row === undefined || row.owner !== ownerId || row.epoch !== epoch) return false;
    row.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async release(jobId: string, ownerId: string, epoch: number): Promise<boolean> {
    const row = this.rows.get(jobId);
    if (row === undefined || row.owner !== ownerId || row.epoch !== epoch) return false;
    row.owner = null;
    row.expiresAt = null;
    return true;
  }

  async findExpired(limit: number): Promise<ExpiredLease[]> {
    const now = Date.now();
    const out: ExpiredLease[] = [];
    for (const [jobId, row] of this.rows) {
      if (row.owner === null || row.expiresAt === null || row.expiresAt >= now) continue;
      out.push({ jobId, status: row.status, leaseOwner: row.owner, leaseEpoch: row.epoch });
      if (out.length >= limit) break;
    }
    return out.sort((a, b) => a.jobId.localeCompare(b.jobId));
  }
}

export interface LeaseManagerOptions {
  ttlMs: number;
  heartbeatMs: number;
  /** Invoked once when a renew fails, i.e. when another node took the job. */
  onLost?: (jobId: string, epoch: number) => void;
}

/**
 * Holds a lease and keeps it alive. When a renew fails the manager aborts the
 * work through the supplied signal rather than letting it keep writing.
 */
export class LeaseManager {
  private timer: NodeJS.Timeout | null = null;
  private lost = false;
  private stopped = false;
  private readonly log = childLogger({ component: 'lease' });

  private constructor(
    private readonly store: LeaseStore,
    readonly jobId: string,
    private readonly ownerId: string,
    readonly epoch: number,
    private readonly options: LeaseManagerOptions,
    readonly signal: AbortSignal,
    private readonly abort: () => void,
  ) {}

  static async acquire(
    store: LeaseStore,
    jobId: string,
    ownerId: string,
    options: LeaseManagerOptions,
  ): Promise<LeaseManager | null> {
    const epoch = await store.tryAcquire(jobId, ownerId, options.ttlMs);
    if (epoch === null) return null;

    const controller = new AbortController();
    const manager = new LeaseManager(
      store,
      jobId,
      ownerId,
      epoch,
      options,
      controller.signal,
      () => controller.abort(),
    );
    manager.start();
    return manager;
  }

  get isLost(): boolean {
    return this.lost;
  }

  private start(): void {
    this.timer = setInterval(() => void this.beat(), this.options.heartbeatMs);
    // Never keep the process alive just to renew a lease.
    this.timer.unref?.();
  }

  private async beat(): Promise<void> {
    if (this.stopped || this.lost) return;
    let ok = false;
    try {
      ok = await this.store.renew(this.jobId, this.ownerId, this.epoch, this.options.ttlMs);
    } catch (error) {
      // A DB blip is not proof of lost ownership; the TTL provides the slack.
      this.log.warn({ jobId: this.jobId, err: (error as Error).message }, 'lease renew failed');
      return;
    }
    if (!ok) {
      this.lost = true;
      this.log.warn({ jobId: this.jobId, epoch: this.epoch }, 'lease lost — another node took over');
      this.options.onLost?.(this.jobId, this.epoch);
      this.abort();
      this.clearTimer();
    }
  }

  /** Force the lost path without waiting for the next tick. Test/recovery hook. */
  async renewNow(): Promise<boolean> {
    await this.beat();
    return !this.lost;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer();
    if (!this.lost) {
      try {
        await this.store.release(this.jobId, this.ownerId, this.epoch);
      } catch (error) {
        this.log.warn({ jobId: this.jobId, err: (error as Error).message }, 'lease release failed');
      }
    }
  }
}
