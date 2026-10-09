import type { Redis } from 'ioredis';

export type JobPhase =
  | 'probing'
  | 'naming'
  | 'session'
  | 'streaming'
  | 'finalizing'
  | 'queued'
  | 'done';

export type JobState = 'QUEUED' | 'TRANSFERRING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface ProgressEvent {
  jobId: string;
  userId: string;
  status: JobState;
  phase: JobPhase | null;
  transferredBytes: number;
  totalBytes: number | null;
  speedBps: number;
  etaSeconds: number | null;
  fileName: string | null;
  driveFileId: string | null;
  webViewLink: string | null;
  error: { code: string; message: string } | null;
  nodeId: string | null;
  at: number;
}

/** Progress is scoped per user so one subscriber never sees another's jobs. */
export function userChannel(userId: string): string {
  return `r2d:progress:user:${userId}`;
}

function snapshotKey(jobId: string): string {
  return `r2d:progress:last:${jobId}`;
}

const SNAPSHOT_TTL_SECONDS = 3600;

/**
 * Publishes progress from workers. Every event is also cached briefly so a UI
 * that connects after a job started can render the current state immediately
 * instead of waiting for the next tick.
 */
export class ProgressPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(event: ProgressEvent): Promise<void> {
    const payload = JSON.stringify(event);
    await Promise.all([
      this.redis.publish(userChannel(event.userId), payload),
      this.redis.set(snapshotKey(event.jobId), payload, 'EX', SNAPSHOT_TTL_SECONDS),
    ]);
  }

  async snapshot(jobIds: string[]): Promise<Map<string, ProgressEvent>> {
    const out = new Map<string, ProgressEvent>();
    if (jobIds.length === 0) return out;
    const values = await this.redis.mget(jobIds.map(snapshotKey));
    jobIds.forEach((jobId, index) => {
      const raw = values[index];
      if (!raw) return;
      try {
        out.set(jobId, JSON.parse(raw) as ProgressEvent);
      } catch {
        // A corrupt snapshot is not worth failing the whole response over.
      }
    });
    return out;
  }
}

export type ProgressHandler = (event: ProgressEvent) => void;

/** One dedicated subscriber connection per open SSE response. */
export class ProgressSubscription implements Disposable {
  private readonly redis: Redis;
  private readonly handlers = new Set<ProgressHandler>();
  private closed = false;

  private constructor(redis: Redis, userId: string) {
    this.redis = redis;
    this.redis.subscribe(userChannel(userId)).catch(() => {
      /* reconnected by ioredis */
    });
    this.redis.on('message', (channel: string, message: string) => {
      if (channel !== userChannel(userId) || this.closed) return;
      let event: ProgressEvent;
      try {
        event = JSON.parse(message) as ProgressEvent;
      } catch {
        return;
      }
      for (const handler of this.handlers) {
        try {
          handler(event);
        } catch {
          // A dead SSE socket must not break the worker's publish path.
        }
      }
    });
  }

  static async open(redis: Redis, userId: string): Promise<ProgressSubscription> {
    const subscription = new ProgressSubscription(redis, userId);
    await new Promise<void>((resolve) => {
      if (subscription.redis.status === 'ready') resolve();
      else subscription.redis.once('ready', () => resolve());
    });
    return subscription;
  }

  onEvent(handler: ProgressHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    this.redis.quit().catch(() => this.redis.disconnect());
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/** Cancellation is a control message, not progress, so it gets its own channel. */
export function cancelChannel(jobId: string): string {
  return `r2d:cancel:${jobId}`;
}

export class CancelNotifier {
  constructor(private readonly redis: Redis) {}

  async request(jobId: string): Promise<void> {
    await this.redis.publish(cancelChannel(jobId), String(Date.now()));
  }
}

export class CancelWatcher implements Disposable {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly redis: Redis,
    private readonly pollMs = 5_000,
  ) {}

  /**
   * Combines a pub/sub signal with periodic polling. Pub/sub alone is not
   * enough: a worker that was down when the cancel was published, or one that
   * inherited a job from a dead node, would never see it.
   */
  watch(jobId: string, isCancelled: () => Promise<boolean>): AbortController {
    const controller = new AbortController();
    let stopped = false;

    const check = async (): Promise<void> => {
      if (stopped || controller.signal.aborted) return;
      try {
        if (await isCancelled()) controller.abort();
      } catch {
        // Transient DB errors must not kill the transfer; poll again later.
      }
    };

    const onMessage = (channel: string): void => {
      if (channel === cancelChannel(jobId)) void check();
    };

    this.redis.subscribe(cancelChannel(jobId)).catch(() => undefined);
    this.redis.on('message', onMessage);
    const timer = setInterval(() => void check(), this.pollMs);
    this.timers.set(jobId, timer);

    controller.signal.addEventListener(
      'abort',
      () => {
        stopped = true;
        const existing = this.timers.get(jobId);
        if (existing !== undefined) clearInterval(existing);
        this.timers.delete(jobId);
        this.redis.removeListener('message', onMessage);
        this.redis.unsubscribe(cancelChannel(jobId)).catch(() => undefined);
      },
      { once: true },
    );

    return controller;
  }

  close(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
