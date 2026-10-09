import { Readable, Transform } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CHUNK_ALIGNMENT } from '../src/config.js';
import {
  alignChunkSize,
  buildContentRange,
  mapDriveError,
  parseRangeOffset,
} from '../src/lib/drive.js';
import { chainStreams, chunkStream } from '../src/lib/transfer.js';
import { byteLimiter, formatBytes } from '../src/lib/http.js';
import { SpeedMeter, Throttle } from '../src/lib/rate.js';
import { computeBackoff } from '../src/lib/backoff.js';

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of source) out.push(Buffer.from(chunk));
  return out;
}

/** Deliberately ragged: real sockets never hand over neat power-of-two reads. */
function raggedParts(total: number, seed = 7): Buffer[] {
  const parts: Buffer[] = [];
  let written = 0;
  let step = seed;
  while (written < total) {
    const size = Math.min(step, total - written);
    const part = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) part[i] = (written + i) & 0xff;
    parts.push(part);
    written += size;
    step = (step * 31 + 17) % 9000 + 1;
  }
  return parts;
}

function expectedBytes(total: number): Buffer {
  const out = Buffer.alloc(total);
  for (let i = 0; i < total; i += 1) out[i] = i & 0xff;
  return out;
}

describe('alignChunkSize', () => {
  it('floors to a multiple of 256 KiB, which is what Drive requires', () => {
    expect(alignChunkSize(16 * 1024 * 1024)).toBe(16 * 1024 * 1024);
    expect(alignChunkSize(CHUNK_ALIGNMENT * 3 + 1)).toBe(CHUNK_ALIGNMENT * 3);
    expect(alignChunkSize(10 * 1024 * 1024)).toBe(10 * 1024 * 1024);
  });

  it('never returns less than one alignment unit', () => {
    expect(alignChunkSize(1)).toBe(CHUNK_ALIGNMENT);
    expect(alignChunkSize(CHUNK_ALIGNMENT - 1)).toBe(CHUNK_ALIGNMENT);
  });

  it('replaces nonsense values with the minimum instead of looping forever', () => {
    expect(alignChunkSize(0)).toBe(CHUNK_ALIGNMENT);
    expect(alignChunkSize(-1)).toBe(CHUNK_ALIGNMENT);
    expect(alignChunkSize(Number.NaN)).toBe(CHUNK_ALIGNMENT);
    expect(alignChunkSize(Number.POSITIVE_INFINITY)).toBe(CHUNK_ALIGNMENT);
  });
});

describe('chunkStream', () => {
  it('reassembles the exact input byte-for-byte', async () => {
    const total = 1024 * 1024 + 1234;
    const parts = raggedParts(total);
    const chunks = await collect(chunkStream(Readable.from(parts), CHUNK_ALIGNMENT));
    expect(Buffer.concat(chunks).equals(expectedBytes(total))).toBe(true);
  });

  it('emits full-size chunks and only one shorter tail', async () => {
    const total = CHUNK_ALIGNMENT * 3 + 999;
    const chunks = await collect(chunkStream(Readable.from(raggedParts(total)), CHUNK_ALIGNMENT));
    expect(chunks).toHaveLength(4);
    expect(chunks.slice(0, 3).every((c) => c.length === CHUNK_ALIGNMENT)).toBe(true);
    expect(chunks[3]?.length).toBe(999);
  });

  it('emits no trailing empty chunk when the length is an exact multiple', async () => {
    const total = CHUNK_ALIGNMENT * 2;
    const chunks = await collect(chunkStream(Readable.from(raggedParts(total)), CHUNK_ALIGNMENT));
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.length === CHUNK_ALIGNMENT)).toBe(true);
  });

  it('emits nothing at all for an empty source', async () => {
    expect(await collect(chunkStream(Readable.from([]), CHUNK_ALIGNMENT))).toEqual([]);
  });

  it('does not overwrite a buffer it has already yielded', async () => {
    // The pipeline holds the previous chunk while the next one fills, so a
    // reused buffer would silently corrupt the chunk already handed out.
    const total = CHUNK_ALIGNMENT * 2;
    const retained: Buffer[] = [];
    for await (const chunk of chunkStream(Readable.from(raggedParts(total)), CHUNK_ALIGNMENT)) {
      retained.push(chunk);
    }
    expect(retained).toHaveLength(2);
    expect(retained[0]!.equals(expectedBytes(CHUNK_ALIGNMENT))).toBe(true);
    expect(Buffer.concat(retained).equals(expectedBytes(total))).toBe(true);
    expect(retained[0]!.buffer).not.toBe(retained[1]!.buffer);
  });

  it('rejects a non-positive chunk size', async () => {
    await expect(collect(chunkStream(Readable.from([Buffer.from('x')]), 0))).rejects.toThrow(RangeError);
  });
});

describe('chainStreams', () => {
  it('passes bytes through every stage in order', async () => {
    const upper = new Transform({
      transform(chunk, _enc, cb) {
        cb(null, Buffer.from(chunk.toString().toUpperCase()));
      },
    });
    const out = await collect(chainStreams(Readable.from([Buffer.from('abc')]), [upper]));
    expect(Buffer.concat(out).toString()).toBe('ABC');
  });

  it('propagates an upstream failure to the consumer', async () => {
    const boom = new Error('source died mid-body');
    const source = new Readable({
      read() {
        this.destroy(boom);
      },
    });
    const passthrough = new Transform({ transform(c, _e, cb) { cb(null, c); } });
    await expect(collect(chainStreams(source, [passthrough]))).rejects.toThrow(boom);
  });

  it('propagates a stage failure to the consumer', async () => {
    const boom = new Error('stage exploded');
    const failing = new Transform({
      transform(_chunk, _enc, cb) {
        cb(boom);
      },
    });
    const source = Readable.from([Buffer.from('data')]);
    await expect(collect(chainStreams(source, [failing]))).rejects.toThrow(boom);
    expect(source.destroyed).toBe(true);
  });
});

describe('buildContentRange', () => {
  it('states the real total when the length is known', () => {
    expect(buildContentRange(0, 1024, 4096, false)).toBe('bytes 0-1023/4096');
    expect(buildContentRange(3072, 1024, 4096, true)).toBe('bytes 3072-4095/4096');
  });

  it('uses a wildcard for intermediate chunks when the length is unknown', () => {
    expect(buildContentRange(0, 1024, null, false)).toBe('bytes 0-1023/*');
    expect(buildContentRange(1024, 512, null, false)).toBe('bytes 1024-1535/*');
  });

  it('declares the total on the final chunk, which is how Drive learns the upload ended', () => {
    expect(buildContentRange(1024, 512, null, true)).toBe('bytes 1024-1535/1536');
  });
});

describe('parseRangeOffset', () => {
  it('converts an inclusive Range end into an exclusive byte count', () => {
    expect(parseRangeOffset('bytes=0-99')).toBe(100);
    expect(parseRangeOffset('bytes=0-0')).toBe(1);
    expect(parseRangeOffset('bytes=1048575-2097151')).toBe(2097152);
  });

  it('treats a missing or malformed header as nothing received', () => {
    expect(parseRangeOffset(undefined)).toBe(0);
    expect(parseRangeOffset('')).toBe(0);
    expect(parseRangeOffset('bytes=0-')).toBe(0);
    expect(parseRangeOffset('nonsense')).toBe(0);
  });
});

describe('mapDriveError', () => {
  const body = (payload: unknown) => Buffer.from(JSON.stringify(payload));

  it('turns an expired or revoked grant into a reconnect instruction', () => {
    const error = mapDriveError(401, body({ error: { message: 'Invalid Credentials' } }), 'uploadChunk');
    expect(error.code).toBe('DRIVE_AUTH_FAILED');
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toContain('connect your Drive again');
  });

  it('recognises an auth-flavoured 403', () => {
    const error = mapDriveError(
      403,
      body({ error: { message: 'no', errors: [{ reason: 'authError' }] } }),
      'uploadChunk',
    );
    expect(error.code).toBe('DRIVE_AUTH_FAILED');
  });

  it('turns a full Drive into a message the user can act on', () => {
    const error = mapDriveError(
      403,
      body({ error: { message: 'The user has exceeded their quota', errors: [{ reason: 'storageQuotaExceeded' }] } }),
      'uploadChunk',
    );
    expect(error.code).toBe('DRIVE_QUOTA_EXCEEDED');
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toContain('storage is full');
  });

  it('retries a plain rate limit but does not blame the user', () => {
    const error = mapDriveError(
      403,
      body({ error: { message: 'slow down', errors: [{ reason: 'rateLimitExceeded' }] } }),
      'uploadChunk',
    );
    expect(error.code).toBe('DRIVE_ERROR');
    expect(error.retryable).toBe(true);
  });

  it('reports a missing folder distinctly', () => {
    const error = mapDriveError(404, body({ error: { message: 'File not found' } }), 'createUploadSession');
    expect(error.code).toBe('DRIVE_FOLDER_NOT_FOUND');
    expect(error.userMessage).toContain('folder');
  });

  it('retries 5xx and 429 but not 400', () => {
    expect(mapDriveError(503, body({}), 'x').retryable).toBe(true);
    expect(mapDriveError(500, body({}), 'x').retryable).toBe(true);
    expect(mapDriveError(429, body({ error: { message: 'too many' } }), 'x').retryable).toBe(true);
    expect(mapDriveError(400, body({ error: { message: 'bad' } }), 'x').retryable).toBe(false);
  });

  it('survives a non-JSON error body', () => {
    const error = mapDriveError(502, Buffer.from('<html>Bad Gateway</html>'), 'uploadChunk');
    expect(error.code).toBe('DRIVE_ERROR');
    expect(error.retryable).toBe(true);
  });
});

describe('byteLimiter', () => {
  it('passes a stream that stays under the cap', async () => {
    const out = await collect(
      chainStreams(Readable.from(raggedParts(5000)), [byteLimiter(10_000)]) as AsyncIterable<Buffer>,
    );
    expect(Buffer.concat(out).length).toBe(5000);
  });

  it('fails a stream that crosses the cap, even with no Content-Length', async () => {
    const limiter = byteLimiter(1000);
    const iterator = collect(chainStreams(Readable.from(raggedParts(50_000)), [limiter]) as AsyncIterable<Buffer>);
    await expect(iterator).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('treats a zero cap as unlimited', async () => {
    const out = await collect(
      chainStreams(Readable.from(raggedParts(20_000)), [byteLimiter(0)]) as AsyncIterable<Buffer>,
    );
    expect(Buffer.concat(out).length).toBe(20_000);
  });
});

describe('Throttle', () => {
  it('holds the observed rate near the configured ceiling', async () => {
    const limit = 64 * 1024;
    const started = Date.now();
    await collect(chainStreams(Readable.from(raggedParts(limit * 2, 3)), [new Throttle(limit)]) as AsyncIterable<Buffer>);
    const elapsed = Date.now() - started;
    // 128 KiB at 64 KiB/s is ~2s; allow wide slack but prove it did not sprint.
    expect(elapsed).toBeGreaterThan(500);
  });
});

describe('SpeedMeter', () => {
  it('estimates throughput from cumulative byte counts', async () => {
    const meter = new SpeedMeter(10_000);
    meter.record(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    meter.record(60_000);
    const speed = meter.bytesPerSecond();
    expect(speed).toBeGreaterThan(0);
    expect(meter.averageBytesPerSecond()).toBeGreaterThan(0);
  });

  it('cannot estimate an ETA when the total is unknown', () => {
    const meter = new SpeedMeter(10_000);
    meter.record(1000);
    expect(meter.etaSeconds(null)).toBeNull();
  });
});

describe('computeBackoff', () => {
  it('grows exponentially and stays under the ceiling', () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const delay = computeBackoff(attempt, 1000, 30_000, () => 1);
      expect(delay).toBeLessThanOrEqual(30_000);
      expect(delay).toBeGreaterThan(0);
    }
  });

  it('jitters within the top half of the ceiling so a fleet does not retry in lockstep', () => {
    const high = computeBackoff(5, 1000, 60_000, () => 1);
    const low = computeBackoff(5, 1000, 60_000, () => 0);
    // 1000 * 2^5 = 32000, so the delay lands somewhere in [16000, 32000].
    expect(high).toBe(32_000);
    expect(low).toBe(16_000);
    expect(high).toBeGreaterThan(low);
  });

  it('clamps the exponent so a high attempt count cannot overflow', () => {
    expect(computeBackoff(500, 1000, 30_000, () => 1)).toBe(30_000);
    expect(computeBackoff(-3, 1000, 30_000, () => 1)).toBe(1000);
  });
});

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(15 * 1024)).toBe('15 KB');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });

  it('never runs off the end of the unit table', () => {
    expect(formatBytes(4 * 1024 ** 4)).toBe('4.0 TB');
    expect(formatBytes(4 * 1024 ** 5)).toBe('4096 TB');
  });
});
