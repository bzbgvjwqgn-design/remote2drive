import { Transform } from 'node:stream';

/**
 * Paces a byte stream by delaying each chunk's callback. Backpressure then
 * propagates upstream to the HTTP socket, which is what keeps the source
 * download from running ahead of the Drive upload.
 */
export class Throttle extends Transform {
  private readonly bytesPerSecond: number;
  private nextAvailableAt = Date.now();
  private timer: NodeJS.Timeout | null = null;

  constructor(bytesPerSecond: number, highWaterMark = 64 * 1024) {
    super({ highWaterMark });
    this.bytesPerSecond = bytesPerSecond > 0 ? bytesPerSecond : 0;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    if (this.bytesPerSecond === 0) {
      callback(null, chunk);
      return;
    }
    const now = Date.now();
    if (this.nextAvailableAt < now) this.nextAvailableAt = now;
    this.nextAvailableAt += (chunk.length / this.bytesPerSecond) * 1000;
    const delay = Math.max(0, Math.ceil(this.nextAvailableAt - now));
    if (delay === 0) {
      callback(null, chunk);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      callback(null, chunk);
    }, delay);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    callback(error);
  }
}

/**
 * Sliding-window rate estimator. Instantaneous speed uses the window so the
 * UI reacts to stalls, while the average spans the whole attempt so ETA does
 * not oscillate wildly.
 */
export class SpeedMeter {
  private readonly windowMs: number;
  private readonly samples: Array<{ at: number; bytes: number }> = [];
  private readonly startedAt: number;
  private lastBytes = 0;

  constructor(windowMs = 10_000, now: () => number = Date.now) {
    this.windowMs = windowMs;
    this.startedAt = now();
    this.now = now;
  }

  private readonly now: () => number;

  /** `cumulativeBytes` is the total transferred since the attempt began. */
  record(cumulativeBytes: number): void {
    const at = this.now();
    this.lastBytes = cumulativeBytes;
    this.samples.push({ at, bytes: cumulativeBytes });
    const cutoff = at - this.windowMs;
    while (this.samples.length > 2 && (this.samples[0]?.at ?? at) < cutoff) {
      this.samples.shift();
    }
  }

  bytesPerSecond(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (first === undefined || last === undefined || last === first) {
      return this.averageBytesPerSecond();
    }
    const seconds = (last.at - first.at) / 1000;
    if (seconds <= 0) return 0;
    return Math.max(0, (last.bytes - first.bytes) / seconds);
  }

  averageBytesPerSecond(): number {
    const seconds = (this.now() - this.startedAt) / 1000;
    if (seconds <= 0) return 0;
    return Math.max(0, this.lastBytes / seconds);
  }

  /** Returns null when the total size is unknown, so the UI can show "—". */
  etaSeconds(remainingBytes: number | null): number | null {
    if (remainingBytes === null || !Number.isFinite(remainingBytes)) return null;
    const rate = this.bytesPerSecond();
    if (rate <= 0) return null;
    return Math.round(remainingBytes / rate);
  }
}
