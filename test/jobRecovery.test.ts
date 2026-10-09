import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import {
  InMemoryLeaseStore,
  LeaseManager,
  type LeaseStore,
} from '../src/worker/lease.js';
import { Reconciler } from '../src/worker/reconciler.js';
import { attemptJobId } from '../src/lib/queue.js';
import { planResume } from '../src/lib/transfer.js';

// ---------------------------------------------------------------------------
// planResume — the decision table for continuing an interrupted transfer
// ---------------------------------------------------------------------------

describe('planResume', () => {
  it('starts fresh when there is no session on record', () => {
    const plan = planResume({ sessionUri: null, driveOffset: 0, sourceSupportsRange: true });
    expect(plan).toMatchObject({ action: 'new-session', downloadFrom: 0 });
  });

  it('reuses an empty session rather than paying to mint another', () => {
    const plan = planResume({ sessionUri: 'uri', driveOffset: 0, sourceSupportsRange: false });
    expect(plan).toMatchObject({ action: 'reuse-session', downloadFrom: 0 });
  });

  it('resumes the download at exactly the offset Drive confirmed', () => {
    const plan = planResume({ sessionUri: 'uri', driveOffset: 4096, sourceSupportsRange: true });
    expect(plan).toMatchObject({ action: 'reuse-session', downloadFrom: 4096 });
    expect(plan.reason).toContain('4096');
  });

  it('discards the session when the source cannot be seeked', () => {
    // Re-downloading from zero into a session that already holds bytes would
    // corrupt the file, so the only safe option is to throw the session away.
    const plan = planResume({ sessionUri: 'uri', driveOffset: 4096, sourceSupportsRange: false });
    expect(plan).toMatchObject({ action: 'new-session', downloadFrom: 0 });
    expect(plan.reason).toContain('does not support Range');
  });
});

// ---------------------------------------------------------------------------
// Lease store — ownership and epoch fencing
// ---------------------------------------------------------------------------

describe('InMemoryLeaseStore', () => {
  it('grants an unheld lease and bumps the epoch', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    expect(await store.tryAcquire('job-1', 'node-a', 60_000)).toBe(1);
    expect(store.inspect('job-1')).toMatchObject({ owner: 'node-a', epoch: 1 });
  });

  it('refuses a second owner while the lease is live', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    await store.tryAcquire('job-1', 'node-a', 60_000);
    expect(await store.tryAcquire('job-1', 'node-b', 60_000)).toBeNull();
    expect(store.inspect('job-1')?.owner).toBe('node-a');
  });

  it('lets the same owner re-acquire its own lease', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    await store.tryAcquire('job-1', 'node-a', 60_000);
    expect(await store.tryAcquire('job-1', 'node-a', 60_000)).toBe(2);
  });

  it('hands an expired lease to a new owner', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1', { owner: 'node-a', expiresAt: Date.now() - 1, epoch: 3, status: 'TRANSFERRING' });
    expect(await store.tryAcquire('job-1', 'node-b', 60_000)).toBe(4);
    expect(store.inspect('job-1')?.owner).toBe('node-b');
  });

  it('rejects a renew from a zombie that lost the lease', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    const epoch = await store.tryAcquire('job-1', 'node-a', 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.tryAcquire('job-1', 'node-b', 60_000);

    // node-a wakes up and tries to keep going. The epoch fence must stop it.
    expect(await store.renew('job-1', 'node-a', epoch!, 60_000)).toBe(false);
    expect(store.inspect('job-1')?.owner).toBe('node-b');
  });

  it('renews for the current owner and pushes the expiry out', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    const epoch = await store.tryAcquire('job-1', 'node-a', 1_000);
    const before = store.inspect('job-1')?.expiresAt ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.renew('job-1', 'node-a', epoch!, 60_000)).toBe(true);
    expect(store.inspect('job-1')!.expiresAt!).toBeGreaterThan(before);
  });

  it('refuses a release from anyone but the current owner at the current epoch', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    const epoch = await store.tryAcquire('job-1', 'node-a', 60_000);
    expect(await store.release('job-1', 'node-b', epoch!)).toBe(false);
    expect(await store.release('job-1', 'node-a', epoch! + 1)).toBe(false);
    expect(store.inspect('job-1')?.owner).toBe('node-a');
    expect(await store.release('job-1', 'node-a', epoch!)).toBe(true);
    expect(store.inspect('job-1')).toMatchObject({ owner: null, expiresAt: null });
  });

  it('reports unknown jobs as unclaimable rather than throwing', async () => {
    const store = new InMemoryLeaseStore();
    expect(await store.tryAcquire('missing', 'node-a', 1000)).toBeNull();
    expect(await store.renew('missing', 'node-a', 1, 1000)).toBe(false);
  });

  it('finds only the expired leases, oldest first, within the limit', async () => {
    const store = new InMemoryLeaseStore();
    const past = Date.now() - 10_000;
    store.seed('job-live', { owner: 'node-a', expiresAt: Date.now() + 60_000, epoch: 1 });
    store.seed('job-free', { owner: null, expiresAt: null, epoch: 0 });
    store.seed('job-b', { owner: 'node-b', expiresAt: past, epoch: 2 });
    store.seed('job-a', { owner: 'node-a', expiresAt: past - 1000, epoch: 5 });

    const expired = await store.findExpired(10);
    expect(expired.map((e) => e.jobId)).toEqual(['job-a', 'job-b']);
    expect(expired[0]).toMatchObject({ leaseOwner: 'node-a', leaseEpoch: 5 });
    expect(await store.findExpired(1)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// LeaseManager — heartbeat, loss detection, abort
// ---------------------------------------------------------------------------

/** Wraps a store so a renew can be made to throw, simulating a database blip. */
function flaky(inner: LeaseStore, failTimes: number): LeaseStore {
  let remaining = failTimes;
  return {
    tryAcquire: (jobId, ownerId, ttl) => inner.tryAcquire(jobId, ownerId, ttl),
    release: (jobId, ownerId, epoch) => inner.release(jobId, ownerId, epoch),
    findExpired: (limit) => inner.findExpired(limit),
    async renew(jobId, ownerId, epoch, ttl) {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error('connection reset');
      }
      return inner.renew(jobId, ownerId, epoch, ttl);
    },
  };
}

describe('LeaseManager', () => {
  it('returns null when another node already owns the job', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    await store.tryAcquire('job-1', 'node-a', 60_000);
    const manager = await LeaseManager.acquire(store, 'job-1', 'node-b', {
      ttlMs: 60_000,
      heartbeatMs: 60_000,
    });
    expect(manager).toBeNull();
  });

  it('holds the lease across heartbeats', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    const manager = await LeaseManager.acquire(store, 'job-1', 'node-a', {
      ttlMs: 60_000,
      heartbeatMs: 60_000,
    });
    expect(manager).not.toBeNull();
    expect(manager!.epoch).toBe(1);
    expect(manager!.signal.aborted).toBe(false);
    expect(await manager!.renewNow()).toBe(true);
    expect(store.inspect('job-1')?.owner).toBe('node-a');
    await manager!.stop();
    expect(store.inspect('job-1')?.owner).toBeNull();
  });

  it('treats a database blip as survivable, because the TTL provides the slack', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    const manager = await LeaseManager.acquire(flaky(store, 2), 'job-1', 'node-a', {
      ttlMs: 60_000,
      heartbeatMs: 60_000,
    });
    expect(await manager!.renewNow()).toBe(true);
    expect(manager!.isLost).toBe(false);
    expect(manager!.signal.aborted).toBe(false);
    await manager!.stop();
  });

  it('aborts the transfer the moment ownership is lost', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    const lost: Array<{ jobId: string; epoch: number }> = [];
    const manager = await LeaseManager.acquire(store, 'job-1', 'node-a', {
      ttlMs: 60_000,
      heartbeatMs: 60_000,
      onLost: (jobId, epoch) => lost.push({ jobId, epoch }),
    });

    // Another node takes over while node-a is paused.
    store.seed('job-1', { owner: 'node-b', expiresAt: Date.now() + 60_000, epoch: manager!.epoch, status: 'TRANSFERRING' });

    expect(await manager!.renewNow()).toBe(false);
    expect(manager!.isLost).toBe(true);
    expect(manager!.signal.aborted).toBe(true);
    expect(lost).toEqual([{ jobId: 'job-1', epoch: 1 }]);

    // Stopping must not release a lease that now belongs to someone else.
    await manager!.stop();
    expect(store.inspect('job-1')?.owner).toBe('node-b');
  });

  it('fires onLost at most once however many heartbeats follow', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    let calls = 0;
    const manager = await LeaseManager.acquire(store, 'job-1', 'node-a', {
      ttlMs: 60_000,
      heartbeatMs: 60_000,
      onLost: () => {
        calls += 1;
      },
    });
    store.seed('job-1', { owner: 'node-b', expiresAt: Date.now() + 60_000, epoch: manager!.epoch });
    await manager!.renewNow();
    await manager!.renewNow();
    expect(calls).toBe(1);
  });

  it('is safe to stop twice', async () => {
    const store = new InMemoryLeaseStore();
    store.seed('job-1');
    const manager = await LeaseManager.acquire(store, 'job-1', 'node-a', { ttlMs: 60_000, heartbeatMs: 60_000 });
    await manager!.stop();
    await manager!.stop();
    expect(store.inspect('job-1')?.owner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reconciler — turning a dead node into a resumed job
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  userId: string;
  status: string;
  attempts: number;
  phase: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: Date;
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    userId: 'user-1',
    status: 'QUEUED',
    attempts: 0,
    phase: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: new Date(Date.now() - 1000),
    ...overrides,
  };
}

class FakePrisma {
  rows: Row[] = [];
  logs: Array<{ jobId: string; level: string; event: string; message: string }> = [];
  /** Force updateMany to match nothing: a node that renewed between scan and update. */
  stealFails = false;

  job = {
    findMany: async (args: {
      where: Record<string, unknown>;
      take?: number;
      orderBy?: Record<string, string>;
    }): Promise<Partial<Row>[]> => {
      const where = args.where as { status: string; leaseExpiresAt?: { lt: Date } };
      const now = new Date();
      let matches: Row[];

      if (where.status === 'TRANSFERRING') {
        matches = this.rows.filter(
          (r) =>
            r.status === 'TRANSFERRING' &&
            r.leaseExpiresAt !== null &&
            r.leaseExpiresAt < (where.leaseExpiresAt?.lt ?? now),
        );
        matches.sort((a, b) => (a.leaseExpiresAt! < b.leaseExpiresAt! ? -1 : 1));
      } else {
        matches = this.rows.filter((r) => {
          if (r.status !== 'QUEUED') return false;
          const due = r.nextAttemptAt === null || r.nextAttemptAt <= now;
          const unleased =
            r.leaseOwner === null || r.leaseExpiresAt === null || r.leaseExpiresAt < now;
          return due && unleased;
        });
        matches.sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1));
      }
      // Detached copies, the way the real client returns them: a later UPDATE
      // must not retroactively change what this scan saw.
      return matches.slice(0, args.take ?? 100).map((r) => ({ ...r }));
    },

    updateMany: async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
      if (this.stealFails) return { count: 0 };
      const where = args.where as { id: string; status: string; leaseExpiresAt?: { lt: Date } };
      let count = 0;
      for (const r of this.rows) {
        if (r.id !== where.id || r.status !== where.status) continue;
        if (where.leaseExpiresAt !== undefined) {
          if (r.leaseExpiresAt === null || !(r.leaseExpiresAt < where.leaseExpiresAt.lt)) continue;
        }
        Object.assign(r, args.data);
        count += 1;
      }
      return { count };
    },
  };

  jobLog = {
    create: async (args: { data: { jobId: string; level: string; event: string; message: string } }) => {
      this.logs.push(args.data);
      return args.data;
    },
  };
}

class FakeQueue {
  added: Array<{ name: string; data: { jobId: string; userId: string; attempt: number }; id: string }> = [];
  private readonly ids = new Set<string>();

  async add(name: string, data: { jobId: string; userId: string; attempt: number }, opts: { jobId: string }) {
    if (this.ids.has(opts.jobId)) {
      throw new Error(`missing key for job ${opts.jobId}`);
    }
    this.ids.add(opts.jobId);
    this.added.push({ name, data, id: opts.jobId });
    return {};
  }
}

function harness(rows: Row[] = [], maxAttempts = 3) {
  const prisma = new FakePrisma();
  prisma.rows = rows;
  const queue = new FakeQueue();
  const reconciler = new Reconciler(
    prisma as unknown as PrismaClient,
    queue as unknown as Queue<{ jobId: string; userId: string; attempt: number }>,
    { maxAttempts, leaseReaperIntervalMs: 60_000, retryBaseDelayMs: 1000, retryMaxDelayMs: 2000 },
  );
  return { prisma, queue, reconciler };
}

describe('Reconciler dead-lease recovery', () => {
  it('requeues a job whose owner stopped heartbeating', async () => {
    const { prisma, queue, reconciler } = harness([
      row('job-1', {
        status: 'TRANSFERRING',
        attempts: 0,
        leaseOwner: 'node-a',
        leaseExpiresAt: new Date(Date.now() - 30_000),
      }),
    ]);

    const result = await reconciler.tick();

    expect(result.recovered).toBe(1);
    expect(prisma.rows[0]).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: 'NODE_LOST',
    });
    expect(prisma.rows[0]?.nextAttemptAt).toBeInstanceOf(Date);
    expect(prisma.rows[0]?.errorMessage).toContain('node-a');
    expect(prisma.logs).toEqual([
      expect.objectContaining({ jobId: 'job-1', event: 'node_lost', level: 'warn' }),
    ]);
    expect(queue.added).toEqual([
      { name: 'transfer', data: { jobId: 'job-1', userId: 'user-1', attempt: 1 }, id: 'job-1:1' },
    ]);
  });

  it('fails the job instead of looping forever once attempts run out', async () => {
    const { prisma, queue, reconciler } = harness(
      [
        row('job-1', {
          status: 'TRANSFERRING',
          attempts: 2,
          leaseOwner: 'node-a',
          leaseExpiresAt: new Date(Date.now() - 30_000),
        }),
      ],
      3,
    );

    await reconciler.tick();

    expect(prisma.rows[0]).toMatchObject({ status: 'FAILED', attempts: 3, errorCode: 'MAX_ATTEMPTS' });
    expect(prisma.rows[0]?.nextAttemptAt).toBeNull();
    expect(prisma.logs[0]).toMatchObject({ event: 'attempts_exhausted', level: 'error' });
    expect(queue.added).toHaveLength(0);
  });

  it('does not steal a job whose owner renewed between the scan and the update', async () => {
    const { prisma, queue, reconciler } = harness([
      row('job-1', {
        status: 'TRANSFERRING',
        leaseOwner: 'node-a',
        leaseExpiresAt: new Date(Date.now() - 30_000),
      }),
    ]);
    prisma.stealFails = true;

    const result = await reconciler.tick();

    expect(result.recovered).toBe(0);
    expect(prisma.rows[0]?.status).toBe('TRANSFERRING');
    expect(prisma.rows[0]?.leaseOwner).toBe('node-a');
    expect(prisma.logs).toHaveLength(0);
    expect(queue.added).toHaveLength(0);
  });

  it('leaves a live transfer alone', async () => {
    const { prisma, queue, reconciler } = harness([
      row('job-1', {
        status: 'TRANSFERRING',
        leaseOwner: 'node-a',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ]);

    const result = await reconciler.tick();

    expect(result.recovered).toBe(0);
    expect(queue.added).toHaveLength(0);
    expect(prisma.rows[0]?.status).toBe('TRANSFERRING');
  });

  it('recovers the longest-dead job first', async () => {
    const { prisma, reconciler } = harness([
      row('recent', {
        status: 'TRANSFERRING',
        leaseOwner: 'node-a',
        leaseExpiresAt: new Date(Date.now() - 10_000),
      }),
      row('oldest', {
        status: 'TRANSFERRING',
        leaseOwner: 'node-b',
        leaseExpiresAt: new Date(Date.now() - 90_000),
      }),
    ]);

    await reconciler.tick();

    expect(prisma.rows.map((r) => r.id)).toEqual(['recent', 'oldest']);
    expect(prisma.logs.map((l) => l.message)).toEqual([
      expect.stringContaining('node-b'),
      expect.stringContaining('node-a'),
    ]);
  });
});

describe('Reconciler queueing', () => {
  it('enqueues due jobs under a deterministic id', async () => {
    const { queue, reconciler } = harness([
      row('job-a', { status: 'QUEUED', attempts: 0, queuedAt: new Date(Date.now() - 5000) }),
      row('job-b', { status: 'QUEUED', attempts: 2, queuedAt: new Date(Date.now() - 1000) }),
    ]);

    const result = await reconciler.tick();

    expect(result.enqueued).toBe(2);
    expect(queue.added.map((a) => a.id)).toEqual(['job-a:0', 'job-b:2']);
    expect(queue.added[0]?.id).toBe(attemptJobId('job-a', 0));
  });

  it('waits for a retry whose backoff has not elapsed', async () => {
    const { queue, reconciler } = harness([
      row('job-later', { status: 'QUEUED', attempts: 1, nextAttemptAt: new Date(Date.now() + 60_000) }),
      row('job-now', { status: 'QUEUED', attempts: 1, nextAttemptAt: new Date(Date.now() - 60_000) }),
    ]);

    await reconciler.tick();

    expect(queue.added.map((a) => a.id)).toEqual(['job-now:1']);
  });

  it('skips a queued job that a node is already holding', async () => {
    const { queue, reconciler } = harness([
      row('job-leased', {
        status: 'QUEUED',
        leaseOwner: 'node-b',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ]);

    const result = await reconciler.tick();

    expect(result.enqueued).toBe(0);
    expect(queue.added).toHaveLength(0);
  });

  it('ignores terminal jobs', async () => {
    const { queue, reconciler } = harness([
      row('done', { status: 'COMPLETED' }),
      row('failed', { status: 'FAILED' }),
      row('cancelled', { status: 'CANCELLED' }),
    ]);

    await reconciler.tick();

    expect(queue.added).toHaveLength(0);
  });

  it('is idempotent: a second tick does not double-enqueue', async () => {
    const { queue, reconciler } = harness([row('job-a', { status: 'QUEUED' })]);

    const first = await reconciler.tick();
    const second = await reconciler.tick();

    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);
    expect(queue.added).toHaveLength(1);
  });

  it('a second tick picks up a job recovered by the first', async () => {
    const { queue, reconciler } = harness([
      row('job-1', {
        status: 'TRANSFERRING',
        leaseOwner: 'node-a',
        leaseExpiresAt: new Date(Date.now() - 30_000),
      }),
    ]);

    await reconciler.tick();
    expect(queue.added).toHaveLength(1);

    // The job is now QUEUED and due; the next tick's queue pass finds it but
    // the deterministic id keeps it from being delivered twice.
    await reconciler.tick();
    expect(queue.added).toHaveLength(1);
  });

  it('refuses to run two ticks at once', async () => {
    const { reconciler } = harness([row('job-a', { status: 'QUEUED' })]);
    const first = reconciler.tick();
    const second = await reconciler.tick();
    expect(second).toEqual({ recovered: 0, enqueued: 0, exhausted: 0 });
    expect((await first).enqueued).toBe(1);
  });

  it('swallows a datastore failure so the interval keeps running', async () => {
    const { reconciler, prisma } = harness([row('job-a', { status: 'QUEUED' })]);
    prisma.job.findMany = async () => {
      throw new Error('connection refused');
    };
    await expect(reconciler.tick()).resolves.toEqual({ recovered: 0, enqueued: 0, exhausted: 0 });
  });
});
