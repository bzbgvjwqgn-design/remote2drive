import type { Job, JobLog } from '@prisma/client';
import { toNumber } from '../db.js';
import type { ProgressEvent } from './progress.js';

export interface JobDto {
  id: string;
  sourceUrl: string;
  fileName: string | null;
  folderId: string | null;
  status: Job['status'];
  phase: string | null;
  totalBytes: number | null;
  transferredBytes: number;
  progress: number | null;
  speedBps: number;
  etaSeconds: number | null;
  driveFileId: string | null;
  driveWebUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  maxAttempts: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  nodeId: string | null;
}

/**
 * Live progress outranks the stored row: Redis carries sub-second updates while
 * Postgres is only written every couple of seconds to keep write load sane.
 */
export function serializeJob(job: Job, live?: ProgressEvent | null): JobDto {
  const totalBytes = job.totalBytes === null ? null : toNumber(job.totalBytes);
  const storedTransferred = toNumber(job.transferredBytes);

  const transferredBytes = live ? Math.max(live.transferredBytes, storedTransferred) : storedTransferred;
  const effectiveTotal = live?.totalBytes ?? totalBytes;
  const progress =
    job.status === 'COMPLETED'
      ? 1
      : effectiveTotal !== null && effectiveTotal > 0
        ? Math.min(1, transferredBytes / effectiveTotal)
        : null;

  return {
    id: job.id,
    sourceUrl: job.sourceUrl,
    fileName: job.resolvedName ?? job.fileName,
    folderId: job.folderId,
    status: job.status,
    phase: job.phase,
    totalBytes: effectiveTotal,
    transferredBytes,
    progress,
    speedBps: live ? live.speedBps : (job.avgSpeedBps ?? 0),
    etaSeconds: live ? live.etaSeconds : null,
    driveFileId: job.driveFileId,
    driveWebUrl: job.driveWebUrl,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    nodeId: live?.nodeId ?? null,
  };
}

export interface JobLogDto {
  at: string;
  level: string;
  event: string;
  message: string;
}

export function serializeLogs(logs: JobLog[]): JobLogDto[] {
  return logs.map((entry) => ({
    at: entry.at.toISOString(),
    level: entry.level,
    event: entry.event,
    message: entry.message,
  }));
}
