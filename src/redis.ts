import { Redis } from 'ioredis';

const retryStrategy = (times: number): number => Math.min(times * 200, 5_000);

/** General purpose connection: publishing progress, admin counters, caches. */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy,
  });
}

/**
 * BullMQ needs a dedicated connection per Worker/Queue and requires
 * `maxRetriesPerRequest: null` so its blocking commands can retry forever.
 */
export function createQueueConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    retryStrategy,
  });
}

/** A pub/sub subscriber cannot also issue normal commands, so it gets its own. */
export function createSubscriber(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    retryStrategy,
  });
}
