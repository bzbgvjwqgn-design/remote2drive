import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_ALIGNMENT } from '../src/config.js';
import { buildContentRange, type DriveClient } from '../src/lib/drive.js';
import { TransferError } from '../src/lib/errors.js';
import { buildPolicy, type SsrfPolicy } from '../src/lib/ssrf.js';
import { runTransfer, type ProgressUpdate } from '../src/lib/transfer.js';

// ---------------------------------------------------------------------------
// Fake source server
// ---------------------------------------------------------------------------

interface SourceConfig {
  body: Buffer;
  contentType: string;
  contentDisposition: string | null;
  /** Anything but 200 forces probeSource down its ranged-GET fallback. */
  headStatus: number;
  advertiseRanges: boolean;
  honourRanges: boolean;
  sendLength: boolean;
  requests: Array<{ method: string; range: string | null }>;
}

const cfg: SourceConfig = {
  body: Buffer.alloc(0),
  contentType: 'application/octet-stream',
  contentDisposition: null,
  headStatus: 200,
  advertiseRanges: true,
  honourRanges: true,
  sendLength: true,
  requests: [],
};

function resetSource(body: Buffer, overrides: Partial<SourceConfig> = {}): void {
  cfg.body = body;
  cfg.contentType = 'application/octet-stream';
  cfg.contentDisposition = null;
  cfg.headStatus = 200;
  cfg.advertiseRanges = true;
  cfg.honourRanges = true;
  cfg.sendLength = true;
  cfg.requests = [];
  Object.assign(cfg, overrides);
}

const server = http.createServer((req, res) => {
  cfg.requests.push({ method: req.method ?? '', range: req.headers.range ?? null });
  // The pipeline tears the socket down the moment it has what it needs, so a
  // reset on the way out is normal rather than an error.
  res.on('error', () => {});

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/missing.bin') {
    res.writeHead(404, { 'content-length': 0 });
    res.end();
    return;
  }
  if (pathname === '/redirect') {
    res.writeHead(302, { location: '/file.bin', 'content-length': 0 });
    res.end();
    return;
  }

  const baseHeaders: Record<string, string | number> = { 'content-type': cfg.contentType };
  if (cfg.contentDisposition !== null) baseHeaders['content-disposition'] = cfg.contentDisposition;

  if (req.method === 'HEAD') {
    if (cfg.headStatus !== 200) {
      res.writeHead(cfg.headStatus, { 'content-length': 0 });
      res.end();
      return;
    }
    if (cfg.sendLength) baseHeaders['content-length'] = cfg.body.length;
    if (cfg.advertiseRanges) baseHeaders['accept-ranges'] = 'bytes';
    res.writeHead(200, baseHeaders);
    res.end();
    return;
  }

  const range = req.headers.range;
  if (cfg.honourRanges && range !== undefined) {
    const match = /^bytes=(\d+)-$/.exec(range);
    if (match !== null && match[1] !== undefined) {
      const start = Number(match[1]);
      const slice = cfg.body.subarray(start);
      res.writeHead(206, {
        ...baseHeaders,
        'content-range': `bytes ${start}-${cfg.body.length - 1}/${cfg.body.length}`,
        'accept-ranges': 'bytes',
        'content-length': slice.length,
      });
      res.end(slice);
      return;
    }
  }

  if (cfg.sendLength) {
    res.writeHead(200, { ...baseHeaders, 'content-length': cfg.body.length });
    res.end(cfg.body);
    return;
  }

  // No Content-Length: Node falls back to chunked encoding, which is exactly
  // the "unknown size" case the pipeline has to survive.
  res.writeHead(200, baseHeaders);
  const step = 64 * 1024;
  let sent = 0;
  const pump = (): void => {
    while (sent < cfg.body.length && !res.destroyed) {
      const end = Math.min(sent + step, cfg.body.length);
      const ok = res.write(cfg.body.subarray(sent, end));
      sent = end;
      if (!ok) {
        res.once('drain', pump);
        return;
      }
    }
    if (!res.destroyed) res.end();
  };
  pump();
});

// ---------------------------------------------------------------------------
// Fake Drive
// ---------------------------------------------------------------------------

interface RecordedChunk {
  start: number;
  length: number;
  range: string;
  isLast: boolean;
}

class StubDrive {
  readonly chunks: RecordedChunk[] = [];
  stored: Buffer = Buffer.alloc(0);
  sessions = 0;
  lastSessionName: string | null = null;
  lastSessionMimeType: string | null = null;
  lastSessionTotal: number | null | undefined = null;
  names = new Set<string>();
  /** Overrides what querySessionOffset reports, to simulate a prior attempt. */
  reportedOffset: number | null = null;
  /** Makes querySessionOffset report the session as gone. */
  sessionExpired = false;
  /** Throws once *after* storing the bytes: a chunk that landed but whose response was lost. */
  failAfterStoring = false;

  async createUploadSession(options: {
    name: string;
    mimeType: string;
    totalBytes?: number | null;
  }): Promise<string> {
    this.sessions += 1;
    this.lastSessionName = options.name;
    this.lastSessionMimeType = options.mimeType;
    this.lastSessionTotal = options.totalBytes ?? null;
    // A brand-new session holds nothing, exactly like the real thing.
    this.stored = Buffer.alloc(0);
    this.reportedOffset = null;
    this.sessionExpired = false;
    return `https://drive.invalid/session/${this.sessions}`;
  }

  async querySessionOffset(
    _uri: string,
    totalBytes: number | null,
  ): Promise<{ offset: number; complete: boolean; file?: ReturnType<StubDrive['file']> }> {
    if (this.sessionExpired) {
      throw new TransferError('DRIVE_SESSION_EXPIRED', 'Resumable upload session no longer exists', {
        retryable: true,
      });
    }
    const offset = this.reportedOffset ?? this.stored.length;
    if (totalBytes !== null && offset >= totalBytes) {
      return { offset, complete: true, file: this.file(offset) };
    }
    return { offset, complete: false };
  }

  async uploadChunk(
    _uri: string,
    start: number,
    chunk: Buffer,
    totalBytes: number | null,
    isLast: boolean,
  ) {
    this.chunks.push({
      start,
      length: chunk.length,
      range: buildContentRange(start, chunk.length, totalBytes, isLast),
      isLast,
    });
    if (start !== this.stored.length) {
      throw new Error(`non-contiguous write: start ${start} but we hold ${this.stored.length}`);
    }
    this.stored = Buffer.concat([this.stored, chunk]);

    if (this.failAfterStoring) {
      this.failAfterStoring = false;
      throw new TransferError('DRIVE_ERROR', 'simulated lost response', { retryable: true });
    }

    const done = totalBytes !== null ? this.stored.length >= totalBytes : isLast;
    if (done) {
      return { complete: true, offset: this.stored.length, status: 200, file: this.file(this.stored.length) };
    }
    return { complete: false, offset: this.stored.length, status: 308 };
  }

  async nameExists(name: string): Promise<boolean> {
    return this.names.has(name);
  }

  file(size: number) {
    return {
      id: 'drive-file-1',
      // Empty when the session was inherited rather than created here: the real
      // API always echoes the name baked into the session, and the pipeline
      // falls back to its own resolved name when it is blank.
      name: this.lastSessionName ?? '',
      mimeType: this.lastSessionMimeType ?? '',
      size: String(size),
      webViewLink: 'https://drive.google.com/file/d/drive-file-1/view',
    };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;
let drive: StubDrive;
let policy: SsrfPolicy;
let origin: string;

function body(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 7 + (i >> 8)) & 0xff;
  return out;
}

interface RunResult {
  result: Awaited<ReturnType<typeof runTransfer>>;
  phases: string[];
  progress: ProgressUpdate[];
  sessions: Array<{ sessionUri: string; offset: number; totalBytes: number | null }>;
  resolved: Array<{ fileName: string; mimeType: string; totalBytes: number | null; finalUrl: string }>;
  logs: Array<{ event: string; message: string }>;
}

async function run(
  overrides: Partial<Parameters<typeof runTransfer>[0]> = {},
  options: Partial<Parameters<typeof runTransfer>[1]> = {},
): Promise<RunResult> {
  const phases: string[] = [];
  const progress: ProgressUpdate[] = [];
  const sessions: RunResult['sessions'] = [];
  const resolved: RunResult['resolved'] = [];
  const logs: RunResult['logs'] = [];

  const result = await runTransfer(
    { jobId: 'job-1', sourceUrl: `${origin}/file.bin`, ...overrides },
    {
      drive: drive as unknown as DriveClient,
      policy,
      chunkSize: CHUNK_ALIGNMENT,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
      progressIntervalMs: 1,
      lookup: async () => ['127.0.0.1'],
      ...options,
    },
    {
      onPhase: (phase) => void phases.push(phase),
      onProgress: (update) => void progress.push(update),
      onSession: (info) => void sessions.push(info),
      onResolved: (info) => void resolved.push(info),
      onLog: (event, message) => void logs.push({ event, message }),
    },
  );

  return { result, phases, progress, sessions, resolved, logs };
}

async function expectFailure(promise: Promise<unknown>): Promise<TransferError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(TransferError);
  return error as TransferError;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  policy = buildPolicy({ allowPrivate: true, allowedPorts: [port] });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  drive = new StubDrive();
});

describe('runTransfer with a known Content-Length', () => {
  it('streams the whole file through in aligned chunks without ever buffering it', async () => {
    const payload = body(MIB);
    resetSource(payload, { contentType: 'video/mp4', contentDisposition: 'attachment; filename="video.mp4"' });

    const { result, phases, progress, sessions, resolved } = await run();

    expect(result.driveFileId).toBe('drive-file-1');
    expect(result.fileName).toBe('video.mp4');
    expect(result.mimeType).toBe('video/mp4');
    expect(result.totalBytes).toBe(MIB);
    expect(drive.stored.equals(payload)).toBe(true);

    // Four chunks: three intermediate, one flagged last.
    expect(drive.chunks).toHaveLength(4);
    expect(drive.chunks.map((c) => c.start)).toEqual([0, CHUNK_ALIGNMENT, CHUNK_ALIGNMENT * 2, CHUNK_ALIGNMENT * 3]);
    expect(drive.chunks.every((c) => c.length === CHUNK_ALIGNMENT)).toBe(true);
    expect(drive.chunks.map((c) => c.isLast)).toEqual([false, false, false, true]);
    expect(drive.chunks[3]?.range).toBe(`bytes ${CHUNK_ALIGNMENT * 3}-${MIB - 1}/${MIB}`);

    // "finalizing" is emitted twice on the normal path (once entering the
    // final chunk, once after Drive confirms), so compare the distinct order.
    const distinct = phases.filter((phase, index) => phase !== phases[index - 1]);
    expect(distinct).toEqual(['probing', 'naming', 'session', 'streaming', 'finalizing']);
    expect(sessions).toEqual([{ sessionUri: 'https://drive.invalid/session/1', offset: 0, totalBytes: MIB }]);
    expect(resolved[0]).toMatchObject({ fileName: 'video.mp4', mimeType: 'video/mp4', totalBytes: MIB });
    expect(progress.at(-1)?.transferredBytes).toBe(MIB);
    expect(drive.lastSessionTotal).toBe(MIB);

    // HEAD probe, then a single plain GET — no Range needed on a fresh job.
    expect(cfg.requests.map((r) => r.method)).toEqual(['HEAD', 'GET']);
    expect(cfg.requests[1]?.range).toBeNull();
  });

  it('renames around a file that already exists in the folder', async () => {
    const payload = body(CHUNK_ALIGNMENT);
    resetSource(payload, { contentDisposition: 'attachment; filename="video.mp4"' });
    drive.names = new Set(['video.mp4', 'video (1).mp4']);

    const { result } = await run();

    expect(result.fileName).toBe('video (2).mp4');
    expect(drive.lastSessionName).toBe('video (2).mp4');
    expect(drive.stored.equals(payload)).toBe(true);
  });

  it('keeps the name the user asked for', async () => {
    resetSource(body(CHUNK_ALIGNMENT), { contentDisposition: 'attachment; filename="server-name.mp4"' });
    const { result } = await run({ fileName: 'mine.mp4' });
    expect(result.fileName).toBe('mine.mp4');
  });

  it('leaves duplicates alone when the operator configured it', async () => {
    resetSource(body(CHUNK_ALIGNMENT), { contentDisposition: 'attachment; filename="video.mp4"' });
    drive.names = new Set(['video.mp4']);
    const { result } = await run({}, { onDuplicate: 'allow' });
    expect(result.fileName).toBe('video.mp4');
  });

  it('rejects an oversized source before downloading a single byte of the body', async () => {
    resetSource(body(MIB));
    const error = await expectFailure(run({}, { maxFileSizeBytes: 1024 }));
    expect(error.code).toBe('FILE_TOO_LARGE');
    expect(error.userMessage).toContain('exceeds');
    expect(drive.sessions).toBe(0);
    expect(cfg.requests.map((r) => r.method)).toEqual(['HEAD']);
  });

  it('still enforces the cap when the source hides its length', async () => {
    resetSource(body(MIB), { headStatus: 405, sendLength: false, advertiseRanges: false, honourRanges: false });
    const error = await expectFailure(run({}, { maxFileSizeBytes: 300_000 }));
    expect(error.code).toBe('FILE_TOO_LARGE');
    expect(drive.stored.length).toBeLessThan(MIB);
  });

  it('derives a name from the URL when the server offers none', async () => {
    resetSource(body(CHUNK_ALIGNMENT), { contentType: 'video/x-matroska' });
    const { result } = await run();
    expect(result.fileName).toBe('file.bin');
    expect(result.mimeType).toBe('video/x-matroska');
  });
});

describe('runTransfer with an unknown Content-Length', () => {
  it('uses wildcard ranges until the final chunk declares the real total', async () => {
    const payload = body(MIB + 1234);
    resetSource(payload, { headStatus: 405, sendLength: false, advertiseRanges: false, honourRanges: false });

    const { result, sessions } = await run();

    expect(drive.stored.equals(payload)).toBe(true);
    expect(result.totalBytes).toBe(payload.length);
    expect(sessions[0]?.totalBytes).toBeNull();
    expect(drive.lastSessionTotal).toBeNull();

    const ranges = drive.chunks.map((c) => c.range);
    expect(ranges.slice(0, -1).every((r) => r.endsWith('/*'))).toBe(true);
    expect(ranges.at(-1)).toBe(`bytes ${CHUNK_ALIGNMENT * 4}-${payload.length - 1}/${payload.length}`);
    expect(drive.chunks.at(-1)?.isLast).toBe(true);

    // HEAD was refused, so the probe fell back to a one-byte ranged GET.
    expect(cfg.requests[0]?.method).toBe('HEAD');
    expect(cfg.requests[1]).toEqual({ method: 'GET', range: 'bytes=0-0' });
  });
});

describe('runTransfer resume', () => {
  it('continues from the offset Drive reports and refetches only the tail', async () => {
    const payload = body(MIB);
    resetSource(payload);
    const held = CHUNK_ALIGNMENT * 2;
    drive.stored = payload.subarray(0, held);
    drive.reportedOffset = held;

    const { result, sessions } = await run({
      resumeSessionUri: 'https://drive.invalid/session/old',
      fileName: 'resume.bin',
    });

    expect(drive.sessions).toBe(0);
    expect(sessions).toEqual([{ sessionUri: 'https://drive.invalid/session/old', offset: held, totalBytes: MIB }]);
    expect(drive.chunks.map((c) => c.start)).toEqual([held, held + CHUNK_ALIGNMENT]);
    expect(drive.stored.equals(payload)).toBe(true);
    expect(result.fileName).toBe('resume.bin');
    expect(result.totalBytes).toBe(MIB);

    const download = cfg.requests.find((r) => r.method === 'GET');
    expect(download?.range).toBe(`bytes=${held}-`);
  });

  it('restarts from zero when the source ignores the Range header', async () => {
    const payload = body(MIB);
    // Probe says ranges are supported, but the GET refuses to honour one.
    resetSource(payload, { advertiseRanges: true, honourRanges: false });
    drive.reportedOffset = CHUNK_ALIGNMENT * 2;

    const { result, sessions, logs } = await run({
      resumeSessionUri: 'https://drive.invalid/session/old',
      fileName: 'resume.bin',
    });

    // Uploading a from-zero body into an offset session would corrupt the file,
    // so the old session must be discarded.
    expect(drive.sessions).toBe(1);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.offset).toBe(0);
    expect(drive.chunks[0]?.start).toBe(0);
    expect(drive.stored.equals(payload)).toBe(true);
    expect(result.totalBytes).toBe(MIB);
    expect(logs.some((l) => l.message.includes('ignored the Range header'))).toBe(true);

    const gets = cfg.requests.filter((r) => r.method === 'GET');
    expect(gets.map((g) => g.range)).toEqual([`bytes=${CHUNK_ALIGNMENT * 2}-`, null]);
  });

  it('starts a fresh session when the stored one has expired', async () => {
    const payload = body(CHUNK_ALIGNMENT * 2);
    resetSource(payload);
    drive.sessionExpired = true;
    drive.reportedOffset = CHUNK_ALIGNMENT;

    const { result } = await run({ resumeSessionUri: 'https://drive.invalid/session/old', fileName: 'x.bin' });

    expect(drive.sessions).toBe(1);
    expect(drive.chunks[0]?.start).toBe(0);
    expect(drive.stored.equals(payload)).toBe(true);
    expect(result.totalBytes).toBe(payload.length);
  });

  it('returns immediately when the previous attempt had in fact finished', async () => {
    const payload = body(CHUNK_ALIGNMENT * 2);
    resetSource(payload);
    drive.reportedOffset = payload.length;

    const { result } = await run({ resumeSessionUri: 'https://drive.invalid/session/old', fileName: 'done.bin' });

    expect(result.driveFileId).toBe('drive-file-1');
    expect(result.totalBytes).toBe(payload.length);
    expect(drive.chunks).toHaveLength(0);
  });
});

describe('runTransfer recovery from a lost upload response', () => {
  it('re-reads the authoritative offset instead of resending bytes Drive already has', async () => {
    const payload = body(MIB);
    resetSource(payload);
    drive.failAfterStoring = true;

    const { result } = await run();

    // The chunk landed server-side even though its response was lost; a blind
    // resend would have duplicated it and corrupted the file.
    expect(drive.stored.equals(payload)).toBe(true);
    expect(result.totalBytes).toBe(MIB);

    const resend = drive.chunks[1];
    expect(resend?.length).toBe(0);
    expect(resend?.start).toBe(CHUNK_ALIGNMENT);
    expect(drive.chunks).toHaveLength(5);
    expect(drive.chunks.filter((c) => c.length === 0)).toHaveLength(1);
  });
});

describe('runTransfer source errors', () => {
  it('surfaces a 404 as a non-retryable source error', async () => {
    resetSource(body(CHUNK_ALIGNMENT));
    const error = await expectFailure(
      run({ sourceUrl: `${origin}/missing.bin` }, {}),
    );
    expect(error.code).toBe('SOURCE_HTTP_ERROR');
    expect(error.status).toBe(404);
  });

  it('follows a redirect and re-validates the new target', async () => {
    const payload = body(CHUNK_ALIGNMENT);
    resetSource(payload);
    const { result } = await run({ sourceUrl: `${origin}/redirect` });
    expect(result.totalBytes).toBe(payload.length);
    expect(drive.stored.equals(payload)).toBe(true);
  });
});
