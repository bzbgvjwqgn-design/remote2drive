import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHUNK_ALIGNMENT } from '../src/config.js';
import { alignChunkSize, DriveClient } from '../src/lib/drive.js';
import { chunkStream } from '../src/lib/transfer.js';
import { TransferError } from '../src/lib/errors.js';

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasOpenssl = opensslAvailable();

interface RecordedPut {
  range: string;
  length: number;
}

type Mode = 'normal' | 'gone' | 'quota' | 'complete' | 'empty200';

/**
 * A minimal stand-in for Drive's resumable upload endpoint. It enforces the
 * same invariant the real one does — chunks must arrive contiguous and
 * aligned — so a bug in our Content-Range arithmetic fails here rather than
 * in production.
 */
class FakeDrive {
  received = Buffer.alloc(0);
  readonly puts: RecordedPut[] = [];
  readonly rangeQueries: string[] = [];
  mode: Mode = 'normal';
  fileName = 'uploaded.bin';
  private readonly sessions = new Set<string>();
  private counter = 0;

  handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'https://drive.test');

    if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      this.counter += 1;
      const sessionUri = `https://localhost:${this.port}/session/${this.counter}`;
      this.sessions.add(sessionUri);
      drain(req).then((body) => {
        this.sessionMetadata = safeJson(body);
        res.writeHead(200, { location: sessionUri, 'content-length': 0 });
        res.end();
      });
      return;
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/session/')) {
      const range = String(req.headers['content-range'] ?? '');
      drain(req).then((body) => {
        if (this.mode === 'gone') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 404, message: 'No such upload session' } }));
          return;
        }
        if (this.mode === 'quota') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { code: 403, message: 'quota exceeded', errors: [{ reason: 'storageQuotaExceeded' }] },
            }),
          );
          return;
        }
        if (this.mode === 'complete') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(this.file(this.received.length + body.length)));
          return;
        }
        if (this.mode === 'empty200') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }

        // A zero-length PUT with "bytes */N" is Drive's offset-query form.
        if (body.length === 0 && /^bytes \*\/(\*|\d+)$/.test(range)) {
          this.rangeQueries.push(range);
          if (this.totalKnown !== null && this.received.length >= this.totalKnown) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(this.file(this.received.length)));
            return;
          }
          this.respond308(res);
          return;
        }

        const match = /^bytes (\d+)-(\d+)\/(\*|\d+)$/.exec(range);
        if (match === null) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 400, message: `Malformed Content-Range: ${range}` } }));
          return;
        }
        const start = Number(match[1]);
        const end = Number(match[2]);
        const total = match[3];

        if (end - start + 1 !== body.length) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { code: 400, message: `Content-Range ${range} disagrees with the ${body.length} byte body` },
            }),
          );
          return;
        }
        if (start !== this.received.length) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 400,
                message: `Non-contiguous chunk: start ${start} but we hold ${this.received.length}`,
              },
            }),
          );
          return;
        }

        this.puts.push({ range, length: body.length });
        this.received = Buffer.concat([this.received, body]);

        const finished = total !== '*' ? this.received.length >= Number(total) : false;
        if (finished) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(this.file(this.received.length)));
          return;
        }
        this.respond308(res);
      });
      return;
    }

    res.writeHead(404).end();
  }

  totalKnown: number | null = null;
  sessionMetadata: Record<string, unknown> | null = null;
  port = 0;

  private respond308(res: ServerResponse): void {
    const headers: Record<string, string | number> = { 'content-length': 0 };
    // Drive omits Range entirely when it holds nothing yet.
    if (this.received.length > 0) headers.range = `bytes=0-${this.received.length - 1}`;
    res.writeHead(308, headers);
    res.end();
  }

  private file(size: number) {
    return {
      id: 'drive-file-id-1',
      name: this.fileName,
      mimeType: 'application/octet-stream',
      size: String(size),
      webViewLink: 'https://drive.google.com/file/d/drive-file-id-1/view',
    };
  }

  reset(): void {
    this.received = Buffer.alloc(0);
    this.puts.length = 0;
    this.rangeQueries.length = 0;
    this.mode = 'normal';
    this.totalKnown = null;
    this.sessionMetadata = null;
  }
}

function drain(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeJson(body: Buffer): Record<string, unknown> {
  try {
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Deterministic pseudo-random payload so a reassembly bug is visible. */
function payload(total: number): Buffer {
  const out = Buffer.alloc(total);
  let state = 12345;
  for (let i = 0; i < total; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out[i] = (state >>> 16) & 0xff;
  }
  return out;
}

const fake = new FakeDrive();
let server: ReturnType<typeof createServer>;
let sessionUri: string;
let previousTlsSetting: string | undefined;
let workdir: string | null = null;

async function captureError(promise: Promise<unknown>): Promise<TransferError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(TransferError);
  return error as TransferError;
}

const client = new DriveClient('client-id', 'client-secret', 'https://app.test/cb', 'refresh-token');

describe.skipIf(!hasOpenssl)('Drive resumable upload protocol', () => {
  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'r2d-drive-'));
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', join(workdir, 'key.pem'),
        '-out', join(workdir, 'cert.pem'),
        '-days', '2',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );

    previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    server = createServer(
      { key: readFileSync(join(workdir, 'key.pem')), cert: readFileSync(join(workdir, 'cert.pem')) },
      (req, res) => fake.handle(req, res),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    fake.port = port;
    sessionUri = `https://localhost:${port}/session/1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
    if (workdir !== null) rmSync(workdir, { recursive: true, force: true });
  });

  it('streams a whole file in aligned chunks that Drive reassembles exactly', async () => {
    fake.reset();
    const body = payload(CHUNK_ALIGNMENT * 3 + 7777);
    const chunkSize = alignChunkSize(CHUNK_ALIGNMENT * 2);

    let offset = 0;
    let result: { complete: boolean; offset: number } | null = null;
    let previous: Buffer | null = null;

    // Same one-chunk-behind loop the real pipeline uses: it is what identifies
    // the final chunk when the source never declared a length.
    for await (const chunk of chunkStream(Readable.from([body]), chunkSize)) {
      if (previous !== null) {
        result = await client.uploadChunk(sessionUri, offset, previous, body.length, false);
        expect(result.complete).toBe(false);
        offset = result.offset;
      }
      previous = chunk;
    }
    if (previous !== null) {
      result = await client.uploadChunk(sessionUri, offset, previous, body.length, true);
    }

    expect(result?.complete).toBe(true);
    expect(fake.received.equals(body)).toBe(true);
    expect(fake.puts).toHaveLength(2);
    expect(fake.puts[0]?.length).toBe(chunkSize);
    expect((fake.puts[0]?.length ?? 0) % CHUNK_ALIGNMENT).toBe(0);
    expect(fake.puts[1]?.range).toBe(`bytes ${chunkSize}-${body.length - 1}/${body.length}`);
  });

  it('uses a wildcard total for intermediate chunks when the length is unknown', async () => {
    fake.reset();
    const body = payload(CHUNK_ALIGNMENT * 2 + 10);
    let offset = 0;
    let previous: Buffer | null = null;
    let last: { complete: boolean } | null = null;

    for await (const chunk of chunkStream(Readable.from([body]), CHUNK_ALIGNMENT)) {
      if (previous !== null) {
        const result = await client.uploadChunk(sessionUri, offset, previous, null, false);
        offset = result.offset;
      }
      previous = chunk;
    }
    if (previous !== null) last = await client.uploadChunk(sessionUri, offset, previous, null, true);

    expect(last?.complete).toBe(true);
    expect(fake.received.equals(body)).toBe(true);
    expect(fake.puts.map((p) => p.range)).toEqual([
      `bytes 0-${CHUNK_ALIGNMENT - 1}/*`,
      `bytes ${CHUNK_ALIGNMENT}-${CHUNK_ALIGNMENT * 2 - 1}/*`,
      `bytes ${CHUNK_ALIGNMENT * 2}-${body.length - 1}/${body.length}`,
    ]);
  });

  it('reports the byte count Drive already holds so an upload can resume', async () => {
    fake.reset();
    const body = payload(CHUNK_ALIGNMENT * 4);
    const first = await client.uploadChunk(sessionUri, 0, body.subarray(0, CHUNK_ALIGNMENT), body.length, false);
    expect(first.complete).toBe(false);
    expect(first.offset).toBe(CHUNK_ALIGNMENT);

    const state = await client.querySessionOffset(sessionUri, body.length);
    expect(state).toEqual({ offset: CHUNK_ALIGNMENT, complete: false });
    expect(fake.rangeQueries).toEqual([`bytes */${body.length}`]);
  });

  it('queries with a wildcard total when the source length was never known', async () => {
    fake.reset();
    await client.uploadChunk(sessionUri, 0, payload(CHUNK_ALIGNMENT), null, false);
    const state = await client.querySessionOffset(sessionUri, null);
    expect(state.offset).toBe(CHUNK_ALIGNMENT);
    expect(fake.rangeQueries).toEqual(['bytes */*']);
  });

  it('sends only the missing tail after an interruption', async () => {
    fake.reset();
    const body = payload(CHUNK_ALIGNMENT * 3);
    await client.uploadChunk(sessionUri, 0, body.subarray(0, CHUNK_ALIGNMENT * 2), body.length, false);

    // Simulate a restart: ask Drive where it got to, then continue from there.
    const state = await client.querySessionOffset(sessionUri, body.length);
    expect(state.offset).toBe(CHUNK_ALIGNMENT * 2);

    const tail = body.subarray(state.offset);
    const done = await client.uploadChunk(sessionUri, state.offset, tail, body.length, true);
    expect(done.complete).toBe(true);
    expect(done.file?.id).toBe('drive-file-id-1');
    expect(fake.received.equals(body)).toBe(true);
    expect(fake.puts).toHaveLength(2);
  });

  it('reports completion when Drive already holds every byte', async () => {
    fake.reset();
    const body = payload(CHUNK_ALIGNMENT);
    fake.totalKnown = body.length;
    await client.uploadChunk(sessionUri, 0, body, body.length, true);

    const state = await client.querySessionOffset(sessionUri, body.length);
    expect(state.complete).toBe(true);
    expect(state.file?.size).toBe(String(body.length));
  });

  it('surfaces a dropped session as a retryable expiry', async () => {
    fake.reset();
    fake.mode = 'gone';
    const error = await captureError(client.uploadChunk(sessionUri, 0, payload(16), null, false));
    expect(error.code).toBe('DRIVE_SESSION_EXPIRED');
    expect(error.retryable).toBe(true);

    const queryError = await captureError(client.querySessionOffset(sessionUri, null));
    expect(queryError.code).toBe('DRIVE_SESSION_EXPIRED');
  });

  it('turns a full Drive into an error the user can act on', async () => {
    fake.reset();
    fake.mode = 'quota';
    const error = await captureError(client.uploadChunk(sessionUri, 0, payload(16), 16, true));
    expect(error.code).toBe('DRIVE_QUOTA_EXCEEDED');
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toContain('storage is full');
  });

  it('rejects a chunk whose Content-Range disagrees with its body', async () => {
    fake.reset();
    await client.uploadChunk(sessionUri, 0, payload(CHUNK_ALIGNMENT), null, false);
    // Skipping ahead is exactly the corruption case the offset re-sync prevents.
    const error = await captureError(
      client.uploadChunk(sessionUri, CHUNK_ALIGNMENT * 5, payload(100), null, false),
    );
    expect(error.code).toBe('DRIVE_ERROR');
    expect(error.message).toContain('Non-contiguous');
  });

  it('treats a 200 carrying no file metadata as a retryable anomaly', async () => {
    fake.reset();
    fake.mode = 'empty200';
    const error = await captureError(client.uploadChunk(sessionUri, 0, payload(64), 64, true));
    expect(error.code).toBe('DRIVE_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('no file metadata');
  });
});

describe('alignChunkSize contract', () => {
  it('always produces a size Drive will accept', () => {
    for (const requested of [1, 1024, 262143, 262144, 1048576, 8 * 1024 * 1024, 33 * 1024 * 1024]) {
      const size = alignChunkSize(requested);
      expect(size % CHUNK_ALIGNMENT, `requested ${requested}`).toBe(0);
      expect(size).toBeGreaterThanOrEqual(CHUNK_ALIGNMENT);
      expect(size).toBeLessThanOrEqual(Math.max(requested, CHUNK_ALIGNMENT));
    }
  });
});
