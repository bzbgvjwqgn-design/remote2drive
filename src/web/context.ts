import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import type { CancelNotifier, ProgressPublisher } from '../lib/progress.js';
import type { TransferJobData } from '../lib/queue.js';
import type { TokenVault } from '../lib/tokens.js';

/** Everything a route handler may need, assembled once at boot. */
export interface AppContext {
  config: AppConfig;
  prisma: PrismaClient;
  vault: TokenVault;
  queue: Queue<TransferJobData>;
  publisher: ProgressPublisher;
  cancelNotifier: CancelNotifier;
  /** Separate connection: SSE subscribers cannot share a command connection. */
  subscriberFactory: () => Redis;
}
