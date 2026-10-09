import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config.js';
import { childLogger } from '../logger.js';
import { DriveClient } from '../lib/drive.js';
import { asTransferError } from '../lib/errors.js';
import { CancelWatcher, ProgressPublisher, type ProgressEvent, type JobPhase } from '../lib/progress.js';
import { buildPolicy } from '../lib/ssrf.js';
import { TokenVault } from '../lib/tokens.js';
import { runTransfer, type TransferResult } from '../lib/transfer.js';
import { computeBackoff } from '../lib/backoff.js';
import { LeaseManager, type LeaseStore } from './lease.js';

/** Statuses a worker may transition a job out of. */
const CLAIMABLE = new Set(['QUEUED', 'TRANSFERRING']);

export interface ProcessorDeps {
  prisma: PrismaClient;
  config: AppConfig;
  vault: TokenVault;
  leaseStore: LeaseStore;
  publisher: ProgressPublisher;
  cancelWatcher: CancelWatcher;
  nodeId: string;
  onActiveChange?: (delta: number) => void;
}

export type ProcessOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'completed'; result: TransferResult }
  | { kind: 'failed'; code: string; message: string; willRetry: boolean }
  | { kind: 'cancelled' }
  | { kind: 'lease-lost' };

const PROGRESS_DB_INTERVAL_MS = 2_000;

/**
 * Runs one job from queue delivery to a terminal state.
 *
 * Ordering matters throughout: the lease is taken before any byte moves, the
 * Drive session URI is persisted as soon as it is minted, and progress is
 * flushed on the way out of every branch — so a node killed at any point
 * leaves behind enough state for another node to resume rather than restart.
 */
export async function processJob(jobId: string, deps: ProcessorDeps): Promise<ProcessOutcome> {
  const { prisma, config, vault, publisher, nodeId } = deps;
  const log = childLogger({ component: 'processor', jobId, nodeId });

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { user: { include: { google: true } } },
  });

  if (job === null) {
    log.warn('job row missing; dropping');
    return { kind: 'skipped', reason: 'job not found' };
  }
  if (!CLAIMABLE.has(job.status)) {
    return { kind: 'skipped', reason: `job already ${job.status}` };
  }
  if (job.user.google === null) {
    await finalizeFailure(prisma, job.id, 'DRIVE_AUTH_FAILED', 'Google Drive is not connected');
    await publishTerminal(publisher, job.id, job.userId, 'FAILED', null, {
      code: 'DRIVE_AUTH_FAILED',
      message: 'Google Drive is not connected to this account.',
    }, nodeId);
    return { kind: 'failed', code: 'DRIVE_AUTH_FAILED', message: 'not connected', willRetry: false };
  }

  const lease = await LeaseManager.acquire(deps.leaseStore, jobId, nodeId, {
    ttlMs: config.leaseTtlMs,
    heartbeatMs: config.leaseHeartbeatMs,
    onLost: (id, epoch) => log.warn({ epoch }, 'lease lost during transfer'),
  });
  if (lease === null) {
    log.info('another node owns this job');
    return { kind: 'skipped', reason: 'lease held elsewhere' };
  }

  deps.onActiveChange?.(1);
  const attempt = job.attempts + 1;

  try {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'TRANSFERRING', phase: 'probing', attempts: attempt, startedAt: new Date(), errorCode: null, errorMessage: null },
    });

    const refreshToken = vault.openRefreshToken(job.user.google);
    const drive = new DriveClient(
      config.googleClientId,
      config.googleClientSecret,
      config.googleRedirectUri,
      refreshToken,
      async (tokens) => {
        if (tokens.refreshToken === null && tokens.expiresAt === null) return;
        // Google rotates refresh tokens; losing the new one would silently
        // break the account on the next transfer.
        const data: Record<string, unknown> = {};
        if (tokens.refreshToken !== null && tokens.refreshToken !== undefined) {
          const sealed = vault.sealSecret(tokens.refreshToken);
          data.tokenCiphertext = sealed.ciphertext;
          data.tokenIv = sealed.iv;
          data.tokenTag = sealed.tag;
          data.tokenKeyVersion = sealed.keyVersion;
        }
        if (tokens.expiresAt !== null && tokens.expiresAt !== undefined) data.expiresAt = tokens.expiresAt;
        await prisma.googleAccount.update({ where: { userId: job.userId }, data }).catch(() => undefined);
      },
    );

    const policy = buildPolicy({
      allowPrivate: config.ssrfAllowPrivate,
      extraBlocked: config.ssrfExtraBlockedCidrs,
      extraAllowed: config.ssrfExtraAllowedCidrs,
      allowedPorts: config.allowedPorts,
    });

    const cancel = deps.cancelWatcher.watch(jobId, async () => {
      const row = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
      return row?.status === 'CANCELLED';
    });
    const signal = AbortSignal.any([lease.signal, cancel.signal]);

    let lastProgressWrite = 0;
    const totalBytesRef = { value: job.totalBytes === null ? null : Number(job.totalBytes) };

    const publish = (
      status: ProgressEvent['status'],
      phase: JobPhase | null,
      transferredBytes: number,
      extra: Partial<ProgressEvent> = {},
    ): Promise<void> =>
      publisher.publish({
        jobId,
        userId: job.userId,
        status,
        phase,
        transferredBytes,
        totalBytes: totalBytesRef.value,
        speedBps: 0,
        etaSeconds: null,
        fileName: job.resolvedName ?? job.fileName,
        driveFileId: job.driveFileId,
        webViewLink: job.driveWebUrl,
        error: null,
        nodeId,
        at: Date.now(),
        ...extra,
      });

    await publish('TRANSFERRING', 'probing', Number(job.transferredBytes));

    const result = await runTransfer(
      {
        jobId,
        sourceUrl: job.sourceUrl,
        fileName: job.resolvedName ?? job.fileName,
        folderId: job.folderId ?? config.driveRootFolderId ?? null,
        mimeType: job.mimeType,
        resumeSessionUri: vault.openSessionUri(job),
        signal,
      },
      {
        drive,
        policy,
        chunkSize: config.chunkSizeBytes,
        maxFileSizeBytes: config.maxFileSizeBytes,
        bandwidthLimitBps: config.bandwidthLimitBps,
        maxRedirects: config.maxRedirects,
        idleTimeoutMs: config.idleTimeoutMs,
        userAgent: config.userAgent,
        onDuplicate: config.onDuplicate,
        retryBaseDelayMs: config.retryBaseDelayMs,
        retryMaxDelayMs: config.retryMaxDelayMs,
      },
      {
        onPhase: async (phase) => {
          await prisma.job.update({ where: { id: jobId }, data: { phase } }).catch(() => undefined);
          await publish('TRANSFERRING', phase as JobPhase, Number(job.transferredBytes));
        },
        onResolved: async (info) => {
          totalBytesRef.value = info.totalBytes;
          await prisma.job
            .update({
              where: { id: jobId },
              data: {
                resolvedName: info.fileName,
                mimeType: info.mimeType,
                totalBytes: info.totalBytes === null ? null : BigInt(info.totalBytes),
                finalUrl: info.finalUrl,
              },
            })
            .catch(() => undefined);
        },
        onSession: async (info) => {
          totalBytesRef.value = info.totalBytes;
          const sealed = vault.sealSessionUri(info.sessionUri);
          await prisma.job
            .update({
              where: { id: jobId },
              data: { ...sealed, uploadOffset: BigInt(info.offset) },
            })
            .catch(() => undefined);
          log.info({ offset: info.offset }, 'resumable session ready');
        },
        onProgress: async (update) => {
          const now = Date.now();
          await publisher.publish({
            jobId,
            userId: job.userId,
            status: 'TRANSFERRING',
            phase: 'streaming',
            transferredBytes: update.transferredBytes,
            totalBytes: update.totalBytes,
            speedBps: update.speedBps,
            etaSeconds: update.etaSeconds,
            fileName: job.resolvedName ?? job.fileName,
            driveFileId: null,
            webViewLink: null,
            error: null,
            nodeId,
            at: now,
          });
          totalBytesRef.value = update.totalBytes;
          // Postgres gets a coarser update than the UI: progress rows are the
          // hottest write in the system and 2s granularity is plenty for resume.
          if (now - lastProgressWrite >= PROGRESS_DB_INTERVAL_MS) {
            lastProgressWrite = now;
            await prisma.job
              .update({
                where: { id: jobId },
                data: {
                  transferredBytes: BigInt(update.transferredBytes),
                  totalBytes: update.totalBytes === null ? undefined : BigInt(update.totalBytes),
                  avgSpeedBps: update.speedBps,
                },
              })
              .catch(() => undefined);
          }
        },
        onLog: async (event, message) => {
          await prisma.jobLog
            .create({ data: { jobId, level: 'info', event, message } })
            .catch(() => undefined);
        },
      },
    );

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        phase: 'done',
        driveFileId: result.driveFileId,
        driveWebUrl: result.webViewLink ?? null,
        resolvedName: result.fileName,
        mimeType: result.mimeType,
        totalBytes: BigInt(result.totalBytes),
        transferredBytes: BigInt(result.totalBytes),
        finalUrl: result.finalUrl,
        finishedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        sessionCiphertext: null,
        sessionIv: null,
        sessionTag: null,
      },
    });
    await prisma.jobLog.create({
      data: { jobId, level: 'info', event: 'completed', message: `${result.fileName} → Drive ${result.driveFileId}` },
    });
    await publisher.publish({
      jobId,
      userId: job.userId,
      status: 'COMPLETED',
      phase: 'done',
      transferredBytes: result.totalBytes,
      totalBytes: result.totalBytes,
      speedBps: 0,
      etaSeconds: 0,
      fileName: result.fileName,
      driveFileId: result.driveFileId,
      webViewLink: result.webViewLink ?? null,
      error: null,
      nodeId,
      at: Date.now(),
    });

    log.info({ driveFileId: result.driveFileId, bytes: result.totalBytes }, 'job completed');
    return { kind: 'completed', result };
  } catch (error) {
    return await handleFailure(error, { jobId, userId: job.userId, attempt, deps, log, lease });
  } finally {
    deps.onActiveChange?.(-1);
    await lease.stop();
  }
}

interface FailureContext {
  jobId: string;
  userId: string;
  attempt: number;
  deps: ProcessorDeps;
  log: ReturnType<typeof childLogger>;
  lease: LeaseManager;
}

async function handleFailure(
  error: unknown,
  context: FailureContext,
): Promise<ProcessOutcome> {
  const { jobId, userId, attempt, deps, log, lease } = context;
  const { prisma, config, publisher, nodeId } = deps;

  // Losing the lease means someone else now owns this job. Leave the row alone
  // entirely — writing to it would race the new owner.
  if (lease.isLost) {
    log.warn('aborted: lease taken over by another node');
    return { kind: 'lease-lost' };
  }

  const transferError = asTransferError(error);

  if (transferError.code === 'CANCELLED') {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'CANCELLED', phase: null, finishedAt: new Date(), errorCode: 'CANCELLED', errorMessage: 'Cancelled by user' },
    });
    await publishTerminal(publisher, jobId, userId, 'CANCELLED', null, null, nodeId);
    log.info('job cancelled');
    return { kind: 'cancelled' };
  }

  const willRetry = transferError.retryable && attempt < config.maxAttempts;
  const delay = computeBackoff(attempt, config.retryBaseDelayMs, config.retryMaxDelayMs);

  // A session that Drive rejected is worthless; dropping it forces a clean
  // restart instead of retrying against a URI that will 404 forever.
  const clearSession = transferError.code === 'DRIVE_SESSION_EXPIRED';

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: willRetry ? 'QUEUED' : 'FAILED',
      phase: null,
      errorCode: transferError.code,
      errorMessage: transferError.userMessage.slice(0, 500),
      nextAttemptAt: willRetry ? new Date(Date.now() + delay) : null,
      finishedAt: willRetry ? null : new Date(),
      ...(clearSession ? { sessionCiphertext: null, sessionIv: null, sessionTag: null } : {}),
    },
  });
  await prisma.jobLog.create({
    data: {
      jobId,
      level: willRetry ? 'warn' : 'error',
      event: willRetry ? 'retry_scheduled' : 'failed',
      message: `${transferError.code}: ${transferError.message}${willRetry ? ` — retry ${attempt + 1}/${config.maxAttempts} in ${Math.round(delay / 1000)}s` : ''}`,
    },
  });
  await publishTerminal(
    publisher,
    jobId,
    userId,
    willRetry ? 'QUEUED' : 'FAILED',
    willRetry ? 'queued' : null,
    { code: transferError.code, message: transferError.userMessage },
    nodeId,
  );

  log[willRetry ? 'warn' : 'error'](
    { code: transferError.code, err: transferError.message, willRetry },
    willRetry ? 'job failed, retry scheduled' : 'job failed permanently',
  );
  return {
    kind: 'failed',
    code: transferError.code,
    message: transferError.userMessage,
    willRetry,
  };
}

async function finalizeFailure(
  prisma: PrismaClient,
  jobId: string,
  code: string,
  message: string,
): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'FAILED', phase: null, errorCode: code, errorMessage: message, finishedAt: new Date() },
  });
}

async function publishTerminal(
  publisher: ProgressPublisher,
  jobId: string,
  userId: string,
  status: ProgressEvent['status'],
  phase: JobPhase | null,
  error: { code: string; message: string } | null,
  nodeId?: string,
): Promise<void> {
  await publisher.publish({
    jobId,
    userId,
    status,
    phase,
    transferredBytes: 0,
    totalBytes: null,
    speedBps: 0,
    etaSeconds: null,
    fileName: null,
    driveFileId: null,
    webViewLink: null,
    error,
    nodeId: nodeId ?? null,
    at: Date.now(),
  });
}
