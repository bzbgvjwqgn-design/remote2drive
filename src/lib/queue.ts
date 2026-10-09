import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const TRANSFER_JOB_NAME = 'transfer';

export interface TransferJobData {
  jobId: string;
  userId: string;
  attempt: number;
}

function queueConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
}

/**
 * BullMQ is only the delivery mechanism here. Authoritative job state, attempt
 * counting and ownership all live in Postgres, which is what lets a job
 * survive the loss of the node that accepted it.
 */
export function createQueue(name: string, url: string): Queue<TransferJobData> {
  return new Queue<TransferJobData>(name, {
    connection: queueConnection(url),
    defaultJobOptions: {
      // Retries are driven by jobs.nextAttemptAt in Postgres, not by BullMQ,
      // so a single delivery attempt per enqueue keeps one policy in charge.
      attempts: 1,
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2_000 },
    },
  });
}

/**
 * Deterministic per-attempt id. BullMQ rejects a duplicate id while the job
 * still exists, which makes the reconciler's "make sure this is queued" step
 * idempotent even when several nodes run it at once.
 */
export function attemptJobId(jobId: string, attempt: number): string {
  return `${jobId}:${attempt}`;
}

export async function enqueueTransfer(
  queue: Queue<TransferJobData>,
  data: TransferJobData,
  delayMs = 0,
): Promise<boolean> {
  const jobId = attemptJobId(data.jobId, data.attempt);
  try {
    await queue.add(TRANSFER_JOB_NAME, data, {
      jobId,
      delay: Math.max(0, delayMs),
      attempts: 1,
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2_000 },
    });
    return true;
  } catch (error) {
    // BullMQ throws when the id already exists; that is the dedupe working.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('missing key for job') || message.includes(jobId)) return false;
    throw error;
  }
}
