import os from 'node:os';
import { Worker, type Job as BullJob } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config.js';
import { Sealer } from '../crypto.js';
import { childLogger } from '../logger.js';
import { createQueueConnection, createRedis } from '../redis.js';
import { TRANSFER_JOB_NAME, createQueue, type TransferJobData } from '../lib/queue.js';
import { CancelWatcher, ProgressPublisher } from '../lib/progress.js';
import { TokenVault } from '../lib/tokens.js';
import { PrismaLeaseStore } from './lease.js';
import { NodeRegistry } from './registry.js';
import { Reconciler } from './reconciler.js';
import { processJob } from './processor.js';

export interface WorkerHandle {
  stop: () => Promise<void>;
  registry: NodeRegistry;
  reconciler: Reconciler;
  activeJobs: () => number;
}

/**
 * Boots the worker half of the service. Everything here is derived from shared
 * Postgres + Redis, so an identical container can be started on any number of
 * VPS nodes and they will divide the queue between them without coordination.
 */
export async function startWorker(config: AppConfig, prisma: PrismaClient): Promise<WorkerHandle> {
  const log = childLogger({ component: 'worker', nodeId: config.nodeId });
  const queueUrl = config.queueRedisUrl ?? config.redisUrl;

  const queue = createQueue(config.queueName, queueUrl);
  const pubsubRedis = createRedis(config.redisUrl);
  const vault = new TokenVault(new Sealer(config.encryptionKey));
  const publisher = new ProgressPublisher(pubsubRedis);
  const cancelWatcher = new CancelWatcher(pubsubRedis);
  const leaseStore = new PrismaLeaseStore(prisma);

  let active = 0;
  const registry = new NodeRegistry(
    prisma,
    {
      id: config.nodeId,
      role: config.role,
      hostname: os.hostname(),
      version: config.appVersion,
      concurrency: config.maxConcurrentJobs,
    },
    15_000,
  );
  registry.setActiveJobs(0);

  const reconciler = new Reconciler(prisma, queue, config);

  const worker = new Worker<TransferJobData>(
    config.queueName,
    async (bullJob: BullJob<TransferJobData>) => {
      const data = bullJob.data;
      active += 1;
      registry.setActiveJobs(active);
      const startedAt = Date.now();
      log.info({ jobId: data.jobId, attempt: data.attempt }, 'job received');
      try {
        const outcome = await processJob(data.jobId, {
          prisma,
          config,
          vault,
          leaseStore,
          publisher,
          cancelWatcher,
          nodeId: config.nodeId,
        });
        if (outcome.kind === 'skipped') log.info({ jobId: data.jobId, reason: outcome.reason }, 'job skipped');
        return outcome;
      } finally {
        active -= 1;
        registry.setActiveJobs(active);
        log.info({ jobId: data.jobId, ms: Date.now() - startedAt }, 'job finished');
      }
    },
    {
      connection: createQueueConnection(queueUrl),
      concurrency: config.maxConcurrentJobs,
      lockDuration: config.workerLockDurationMs,
      // Recover stalled jobs faster than the default 30s/2m combination.
      stalledInterval: 30_000,
      maxStalledCount: 2,
      autorun: true,
    },
  );

  worker.on('failed', (bullJob, error) => {
    log.error({ jobId: bullJob?.data?.jobId, err: error.message }, 'worker reported failure');
  });
  worker.on('error', (error) => {
    log.error({ err: error.message }, 'worker error');
  });

  await registry.start();
  reconciler.start();

  log.info(
    { concurrency: config.maxConcurrentJobs, queue: config.queueName },
    'worker started',
  );

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('worker stopping — waiting for in-flight jobs');
    reconciler.stop();
    // `close(true)` waits for running jobs; a hard kill would drop leases and
    // force every in-flight transfer to be recovered from scratch.
    await Promise.race([
      worker.close(true),
      new Promise((resolve) => setTimeout(resolve, 30_000).unref?.()),
    ]);
    cancelWatcher.close();
    await registry.stop();
    await queue.close().catch(() => undefined);
    pubsubRedis.disconnect();
    log.info('worker stopped');
  };

  return { stop, registry, reconciler, activeJobs: () => active };
}

export { TRANSFER_JOB_NAME };
