import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { computeBackoff, sleep } from './backoff.js';
import { alignChunkSize, DriveClient, type DriveFile } from './drive.js';
import { TransferError } from './errors.js';
import { nextAvailableName, pickFileName } from './filename.js';
import {
  byteLimiter,
  fetchRemote,
  formatBytes,
  readBodySnippet,
  type RemoteResponse,
} from './http.js';
import { SpeedMeter, Throttle } from './rate.js';
import type { SsrfPolicy } from './ssrf.js';

export interface TransferOptions {
  drive: DriveClient;
  policy: SsrfPolicy;
  chunkSize?: number;
  maxFileSizeBytes?: number;
  bandwidthLimitBps?: number;
  maxRedirects?: number;
  idleTimeoutMs?: number;
  userAgent?: string;
  onDuplicate?: 'rename' | 'allow';
  chunkRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  progressIntervalMs?: number;
  /** Test seam: replaces DNS while leaving every other guard in place. */
  lookup?: (hostname: string) => Promise<string[]>;
}

export interface TransferInput {
  jobId: string;
  sourceUrl: string;
  fileName?: string | null;
  folderId?: string | null;
  mimeType?: string | null;
  /** Decrypted resumable-session URI from an earlier attempt, if any. */
  resumeSessionUri?: string | null;
  signal?: AbortSignal;
}

export interface ProgressUpdate {
  transferredBytes: number;
  totalBytes: number | null;
  speedBps: number;
  etaSeconds: number | null;
}

export interface TransferEvents {
  onPhase?: (phase: string) => void | Promise<void>;
  onProgress?: (update: ProgressUpdate) => void | Promise<void>;
  onSession?: (info: { sessionUri: string; offset: number; totalBytes: number | null }) => void | Promise<void>;
  onResolved?: (info: { fileName: string; mimeType: string; totalBytes: number | null; finalUrl: string }) => void | Promise<void>;
  onLog?: (event: string, message: string) => void | Promise<void>;
}

export interface TransferResult {
  driveFileId: string;
  webViewLink?: string | null;
  fileName: string;
  mimeType: string;
  totalBytes: number;
  finalUrl: string;
}

export interface SourceProbe {
  finalUrl: string;
  status: number;
  contentType: string | null;
  contentDisposition: string | null;
  totalBytes: number | null;
  supportsRange: boolean;
}

export type Phase = 'probing' | 'naming' | 'session' | 'streaming' | 'finalizing';

// ---------------------------------------------------------------------------
// Resume planning — pure so it can be unit tested without network or DB.
// ---------------------------------------------------------------------------

export interface ResumePlan {
  action: 'reuse-session' | 'new-session';
  downloadFrom: number;
  reason: string;
}

/**
 * Decides how to continue an interrupted attempt.
 *
 * The Drive session offset is the single source of truth: bytes Drive already
 * holds must not be sent again, so the download has to be reopened from
 * exactly that point. When the source cannot satisfy a Range request there is
 * no way to seek it, and the only correct option is to throw the session away
 * and start both sides over.
 */
export function planResume(input: {
  sessionUri: string | null;
  driveOffset: number;
  sourceSupportsRange: boolean;
}): ResumePlan {
  if (!input.sessionUri) {
    return { action: 'new-session', downloadFrom: 0, reason: 'no resumable session on record' };
  }
  if (input.driveOffset <= 0) {
    return { action: 'reuse-session', downloadFrom: 0, reason: 'session is empty, reusing it' };
  }
  if (input.sourceSupportsRange) {
    return {
      action: 'reuse-session',
      downloadFrom: input.driveOffset,
      reason: `resuming download at byte ${input.driveOffset}`,
    };
  }
  return {
    action: 'new-session',
    downloadFrom: 0,
    reason: `source does not support Range requests; discarding ${input.driveOffset} uploaded bytes and restarting`,
  };
}

// ---------------------------------------------------------------------------
// Chunking — pre-allocated, single-copy, exactly chunkSize except the last.
// ---------------------------------------------------------------------------

/**
 * Groups an arbitrary byte stream into fixed-size chunks. Buffers are filled
 * in place rather than concatenated, so throughput does not degrade as the
 * chunk grows.
 */
export async function* chunkStream(
  source: AsyncIterable<Buffer>,
  chunkSize: number,
): AsyncGenerator<Buffer, void, undefined> {
  if (chunkSize <= 0) throw new RangeError('chunkSize must be positive');
  let buffer = Buffer.allocUnsafe(chunkSize);
  let filled = 0;

  for await (const part of source) {
    let view = part as Buffer;
    while (view.length > 0) {
      const take = Math.min(chunkSize - filled, view.length);
      view.copy(buffer, filled, 0, take);
      filled += take;
      view = view.subarray(take);
      if (filled === chunkSize) {
        yield buffer;
        buffer = Buffer.allocUnsafe(chunkSize);
        filled = 0;
      }
    }
  }
  if (filled > 0) {
    // The tail is the only chunk allowed to be shorter than chunkSize.
    yield buffer.subarray(0, filled);
    buffer = Buffer.alloc(0);
    filled = 0;
  }
}

// ---------------------------------------------------------------------------
// Source probing
// ---------------------------------------------------------------------------

/**
 * Pipes the download through the size limiter and throttle.
 *
 * `.pipe()` does not forward errors, so both directions are wired by hand: a
 * failed chunk upload must tear down the socket, and a source that dies
 * mid-body must surface at the end of the chain rather than hanging forever.
 */
export function chainStreams(head: Readable, stages: Transform[]): AsyncIterable<Buffer> {
  let current: Readable = head;
  for (const stage of stages) {
    const upstream = current;
    upstream.on('error', (error) => stage.destroy(error));
    stage.on('error', (error) => upstream.destroy(error));
    current = upstream.pipe(stage);
  }
  return current as AsyncIterable<Buffer>;
}

function parseContentRangeTotal(header: string | undefined | null): number | null {
  if (!header) return null;
  const match = /\/\s*(\d+)\s*$/i.exec(header);
  return match?.[1] ? Number(match[1]) : null;
}

function headerString(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

function describeResponse(
  response: RemoteResponse,
  overrides: { totalBytes?: number | null; supportsRange?: boolean } = {},
): SourceProbe {
  // A missing Content-Length (chunked encoding) must stay unknown: Number(null)
  // is 0, which would silently truncate the transfer to an empty file.
  const rawLength = headerString(response.headers['content-length']);
  const contentLength = rawLength === null ? Number.NaN : Number(rawLength);
  const acceptRanges = (headerString(response.headers['accept-ranges']) ?? '').toLowerCase();
  return {
    finalUrl: response.finalUrl,
    status: response.status,
    contentType: headerString(response.headers['content-type']),
    contentDisposition: headerString(response.headers['content-disposition']),
    totalBytes:
      overrides.totalBytes !== undefined
        ? overrides.totalBytes
        : Number.isFinite(contentLength) && contentLength >= 0
          ? contentLength
          : null,
    supportsRange:
      overrides.supportsRange !== undefined
        ? overrides.supportsRange
        : acceptRanges === 'bytes' || acceptRanges.startsWith('bytes'),
  };
}

function httpErrorFor(status: number, url: string): TransferError {
  const retryable = status >= 500 || status === 429 || status === 408;
  const userMessage =
    status === 401 || status === 403
      ? `The source refused the request (HTTP ${status}). It may need authentication.`
      : status === 404
        ? `The source returned HTTP 404 — the file is gone or the link is wrong.`
        : `The source returned HTTP ${status}.`;
  return new TransferError('SOURCE_HTTP_ERROR', `HTTP ${status} from ${url}`, {
    status,
    retryable,
    userMessage,
  });
}

/**
 * HEAD first, because it is cheap; a range-GET fallback covers the many hosts
 * that reject HEAD outright (S3 presigned URLs, some CDNs, nginx autoindex).
 */
export async function probeSource(
  url: string,
  options: TransferOptions,
  signal?: AbortSignal,
): Promise<SourceProbe> {
  const shared = {
    policy: options.policy,
    maxRedirects: options.maxRedirects,
    idleTimeoutMs: options.idleTimeoutMs,
    userAgent: options.userAgent,
    signal,
    ...(options.lookup ? { lookup: options.lookup } : {}),
  };

  try {
    const response = await fetchRemote(url, { ...shared, method: 'HEAD' });
    try {
      if (response.status >= 200 && response.status < 300) {
        return describeResponse(response);
      }
      if (![400, 403, 405, 426, 501].includes(response.status)) {
        throw httpErrorFor(response.status, url);
      }
      // HEAD is not usable here — fall through to the ranged GET below.
    } finally {
      response.release();
    }
  } catch (error) {
    if (error instanceof TransferError && error.code === 'SOURCE_HTTP_ERROR') throw error;
    // A HEAD-specific network failure is worth one GET attempt before giving up.
  }

  const response = await fetchRemote(url, {
    ...shared,
    method: 'GET',
    headers: { range: 'bytes=0-0' },
  });
  try {
    if (response.status === 206) {
      return describeResponse(response, {
        supportsRange: true,
        totalBytes: parseContentRangeTotal(headerString(response.headers['content-range'])),
      });
    }
    if (response.status === 416) {
      return describeResponse(response, {
        supportsRange: true,
        totalBytes: parseContentRangeTotal(headerString(response.headers['content-range'])),
      });
    }
    if (response.status >= 200 && response.status < 300) {
      return describeResponse(response, { supportsRange: false });
    }
    throw httpErrorFor(response.status, url);
  } finally {
    response.release();
  }
}

// ---------------------------------------------------------------------------
// Chunk sending with offset re-synchronisation
// ---------------------------------------------------------------------------

interface ChunkOutcome {
  complete: boolean;
  offset: number;
  file?: DriveFile;
}

/**
 * Sends one logical chunk, tolerating partial acceptance and transient
 * failures.
 *
 * After any error the authoritative offset is re-read from Drive rather than
 * assumed: a chunk may have landed server-side even though the response was
 * lost, and blindly resending it would corrupt the file. Whatever Drive
 * reports is used to slice the remainder out of the original chunk buffer.
 */
async function sendChunk(
  drive: DriveClient,
  sessionUri: string,
  chunkStart: number,
  chunk: Buffer,
  totalBytes: number | null,
  isLast: boolean,
  options: TransferOptions,
  signal?: AbortSignal,
): Promise<ChunkOutcome> {
  const retries = options.chunkRetries ?? 3;
  const base = options.retryBaseDelayMs ?? 2_000;
  const max = options.retryMaxDelayMs ?? 60_000;
  let confirmed = chunkStart;

  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw new TransferError('CANCELLED', 'Transfer cancelled');

    const pending = chunk.subarray(confirmed - chunkStart);
    try {
      const result = await drive.uploadChunk(sessionUri, confirmed, pending, totalBytes, isLast, signal);
      if (result.complete) {
        return { complete: true, offset: chunkStart + chunk.length, file: result.file };
      }
      if (result.offset >= chunkStart + chunk.length) {
        return { complete: false, offset: result.offset };
      }
      if (result.offset >= chunkStart) {
        // Drive took part of the chunk. Advance and resend the remainder
        // immediately — this is not a failure, just a short write.
        confirmed = result.offset;
        if (attempt >= retries) {
          throw new TransferError(
            'DRIVE_ERROR',
            `Drive stopped accepting data at byte ${confirmed}`,
            { retryable: true },
          );
        }
        continue;
      }
      throw new TransferError(
        'DRIVE_SESSION_EXPIRED',
        `Drive reported offset ${result.offset} behind our ${confirmed}; session state diverged`,
        { retryable: true },
      );
    } catch (error) {
      if (error instanceof TransferError && error.code === 'CANCELLED') throw error;
      const transferError =
        error instanceof TransferError
          ? error
          : new TransferError('DRIVE_ERROR', (error as Error).message, { retryable: true, cause: error });
      if (!transferError.retryable || attempt >= retries) throw transferError;

      await sleep(computeBackoff(attempt, base, max), signal).catch(() => {
        throw new TransferError('CANCELLED', 'Transfer cancelled');
      });

      // Re-sync before resending: the failed PUT may in fact have been applied.
      const state = await drive.querySessionOffset(sessionUri, totalBytes, signal);
      if (state.complete) {
        return { complete: true, offset: chunkStart + chunk.length, file: state.file };
      }
      if (state.offset >= chunkStart && state.offset <= chunkStart + chunk.length) {
        confirmed = state.offset;
        continue;
      }
      if (state.offset > chunkStart + chunk.length) {
        return { complete: false, offset: state.offset };
      }
      throw new TransferError(
        'DRIVE_SESSION_EXPIRED',
        `Drive rewound to byte ${state.offset}; session is unusable`,
        { retryable: true },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function openDownload(
  url: string,
  from: number,
  options: TransferOptions,
  signal?: AbortSignal,
): Promise<{ response: RemoteResponse; rangeHonoured: boolean }> {
  const response = await fetchRemote(url, {
    policy: options.policy,
    method: 'GET',
    maxRedirects: options.maxRedirects,
    idleTimeoutMs: options.idleTimeoutMs,
    userAgent: options.userAgent,
    signal,
    headers: from > 0 ? { range: `bytes=${from}-` } : undefined,
    ...(options.lookup ? { lookup: options.lookup } : {}),
  });

  if (response.status === 206) return { response, rangeHonoured: true };
  if (response.status >= 200 && response.status < 300) {
    return { response, rangeHonoured: from === 0 };
  }
  if (response.status === 416) {
    response.release();
    throw new TransferError(
      'SOURCE_HTTP_ERROR',
      `Source rejected Range: bytes=${from}- with HTTP 416`,
      { userMessage: 'The source no longer has the bytes needed to resume this transfer.' },
    );
  }
  const body = await readBodySnippet(response.body).catch(() => '');
  response.release();
  throw httpErrorFor(response.status, `${url}${body ? ` (${body.slice(0, 120)})` : ''}`);
}

/**
 * Streams a remote URL into Google Drive without ever holding the file on disk
 * or in memory beyond two chunks.
 */
export async function runTransfer(
  input: TransferInput,
  options: TransferOptions,
  events: TransferEvents = {},
): Promise<TransferResult> {
  const chunkSize = alignChunkSize(options.chunkSize ?? 16 * 1024 * 1024);
  const maxFileSize = options.maxFileSizeBytes ?? 0;
  const onDuplicate = options.onDuplicate ?? 'rename';

  const phase = async (name: Phase): Promise<void> => {
    await events.onPhase?.(name);
  };
  const log = async (event: string, message: string): Promise<void> => {
    await events.onLog?.(event, message);
  };
  const throwIfCancelled = (): void => {
    if (input.signal?.aborted) throw new TransferError('CANCELLED', 'Transfer cancelled');
  };

  // -- 1. probe -------------------------------------------------------------
  await phase('probing');
  throwIfCancelled();
  const probe = await probeSource(input.sourceUrl, options, input.signal);
  let totalBytes = probe.totalBytes;

  if (maxFileSize > 0 && totalBytes !== null && totalBytes > maxFileSize) {
    throw new TransferError(
      'FILE_TOO_LARGE',
      `Source advertises ${totalBytes} bytes, limit is ${maxFileSize}`,
      { userMessage: `File (${formatBytes(totalBytes)}) exceeds the ${formatBytes(maxFileSize)} limit.` },
    );
  }
  await log('probe', `HTTP ${probe.status}, ${totalBytes === null ? 'unknown size' : formatBytes(totalBytes)}, range=${probe.supportsRange}`);

  // -- 2. resolve the destination name --------------------------------------
  await phase('naming');
  throwIfCancelled();

  const isResume = Boolean(input.resumeSessionUri);
  const mimeType =
    input.mimeType || probe.contentType?.split(';')[0]?.trim() || 'application/octet-stream';

  let fileName: string;
  if (isResume) {
    // The name was baked into the existing session; changing it now would
    // produce a file whose metadata disagrees with what Drive is receiving.
    fileName = input.fileName ?? 'download';
  } else {
    fileName = pickFileName({
      userSupplied: input.fileName,
      contentDisposition: probe.contentDisposition,
      contentType: probe.contentType,
      url: probe.finalUrl,
    });
    if (onDuplicate === 'rename') {
      const folderId = input.folderId ?? null;
      fileName = await nextAvailableName(fileName, (candidate) =>
        options.drive.nameExists(candidate, folderId, input.signal),
      );
    }
  }
  await events.onResolved?.({
    fileName,
    mimeType,
    totalBytes,
    finalUrl: probe.finalUrl,
  });

  // -- 3. resumable session -------------------------------------------------
  await phase('session');
  throwIfCancelled();

  let sessionUri: string | null = null;
  let driveOffset = 0;

  if (input.resumeSessionUri) {
    try {
      const state = await options.drive.querySessionOffset(
        input.resumeSessionUri,
        totalBytes,
        input.signal,
      );
      if (state.complete && state.file) {
        await log('resume', 'previous session had already completed');
        return {
          driveFileId: state.file.id,
          webViewLink: state.file.webViewLink ?? null,
          fileName: state.file.name || fileName,
          mimeType: state.file.mimeType || mimeType,
          totalBytes: Number(state.file.size ?? totalBytes ?? 0),
          finalUrl: probe.finalUrl,
        };
      }
      sessionUri = input.resumeSessionUri;
      driveOffset = state.offset;
    } catch (error) {
      if (error instanceof TransferError && error.code === 'DRIVE_SESSION_EXPIRED') {
        await log('resume', 'stored session expired, starting a new one');
        sessionUri = null;
        driveOffset = 0;
      } else {
        throw error;
      }
    }
  }

  const plan = planResume({
    sessionUri,
    driveOffset,
    sourceSupportsRange: probe.supportsRange,
  });

  if (plan.action === 'new-session' || sessionUri === null) {
    sessionUri = await options.drive.createUploadSession(
      { name: fileName, mimeType, parentFolderId: input.folderId ?? null, totalBytes },
      input.signal,
    );
    driveOffset = 0;
  }
  await log('resume', plan.reason);
  await events.onSession?.({ sessionUri, offset: driveOffset, totalBytes });

  // -- 4. open the download at the resume point -----------------------------
  throwIfCancelled();
  let { response, rangeHonoured } = await openDownload(
    probe.finalUrl,
    plan.downloadFrom,
    options,
    input.signal,
  );

  if (plan.downloadFrom > 0 && !rangeHonoured) {
    // The source ignored Range and sent the whole file from byte 0. Uploading
    // that over an offset session would corrupt it, so discard the session.
    response.release();
    await log('resume', 'source ignored the Range header; restarting with a fresh session');
    sessionUri = await options.drive.createUploadSession(
      { name: fileName, mimeType, parentFolderId: input.folderId ?? null, totalBytes },
      input.signal,
    );
    driveOffset = 0;
    await events.onSession?.({ sessionUri, offset: 0, totalBytes });
    ({ response, rangeHonoured } = await openDownload(probe.finalUrl, 0, options, input.signal));
  }

  const liveTotal = rangeHonoured
    ? totalBytes
    : (headerString(response.headers['content-length']) !== null
        ? Number(headerString(response.headers['content-length']))
        : totalBytes);

  // -- 5. stream ------------------------------------------------------------
  await phase('streaming');
  const finalSessionUri = sessionUri;
  const meter = new SpeedMeter(10_000);
  const progressInterval = options.progressIntervalMs ?? 500;
  let lastProgressAt = 0;
  let offset = driveOffset;
  let completedFile: DriveFile | undefined;

  const emitProgress = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastProgressAt < progressInterval) return;
    lastProgressAt = now;
    meter.record(offset - driveOffset);
    const remaining = liveTotal === null ? null : Math.max(0, liveTotal - (offset - driveOffset));
    await events.onProgress?.({
      transferredBytes: offset,
      totalBytes: liveTotal,
      speedBps: Math.round(meter.bytesPerSecond()),
      etaSeconds: meter.etaSeconds(remaining),
    });
  };

  const stages: Transform[] = [];
  if (maxFileSize > 0) stages.push(byteLimiter(maxFileSize));
  if ((options.bandwidthLimitBps ?? 0) > 0) stages.push(new Throttle(options.bandwidthLimitBps ?? 0));

  const source = chainStreams(response.body, stages);

  try {
    // Holding the previous chunk until the next one arrives is what tells us
    // which chunk is last when the source never declared a length.
    let previous: Buffer | null = null;

    for await (const chunk of chunkStream(source, chunkSize)) {
      throwIfCancelled();
      if (previous !== null) {
        const outcome = await sendChunk(
          options.drive,
          finalSessionUri,
          offset,
          previous,
          liveTotal,
          false,
          options,
          input.signal,
        );
        offset = outcome.offset;
        if (outcome.complete) {
          completedFile = outcome.file;
          previous = null;
          break;
        }
        previous = null;
        await emitProgress();
      }
      previous = chunk;

      if (liveTotal !== null && offset > liveTotal) {
        throw new TransferError(
          'SOURCE_HTTP_ERROR',
          `Source delivered ${offset} bytes but declared ${liveTotal}`,
          { userMessage: 'The source sent more data than it declared. The link may be unstable.' },
        );
      }
    }

    if (completedFile === undefined && previous !== null) {
      throwIfCancelled();
      await phase('finalizing');
      const outcome = await sendChunk(
        options.drive,
        finalSessionUri,
        offset,
        previous,
        liveTotal,
        true,
        options,
        input.signal,
      );
      offset = outcome.offset;
      completedFile = outcome.file;
    }

    if (completedFile === undefined) {
      // Source ended without Drive ever reporting completion.
      if (liveTotal !== null && offset < liveTotal) {
        throw new TransferError(
          'SOURCE_HTTP_ERROR',
          `Source ended at ${offset} of ${liveTotal} bytes`,
          {
            retryable: true,
            userMessage: 'The connection to the source dropped before the file finished.',
          },
        );
      }
      const state = await options.drive.querySessionOffset(finalSessionUri, liveTotal, input.signal);
      if (!state.complete || !state.file) {
        throw new TransferError(
          'DRIVE_ERROR',
          'Upload ended without a completed Drive file',
          { retryable: true },
        );
      }
      completedFile = state.file;
      offset = state.offset;
    }

    await phase('finalizing');
    await emitProgress(true);

    return {
      driveFileId: completedFile.id,
      webViewLink: completedFile.webViewLink ?? null,
      fileName: completedFile.name || fileName,
      mimeType: completedFile.mimeType || mimeType,
      totalBytes: Number(completedFile.size ?? offset),
      finalUrl: probe.finalUrl,
    };
  } finally {
    response.release();
  }
}
