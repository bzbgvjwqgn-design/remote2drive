import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { ConfigError, getConfig, loadConfig } from './config.js';
import { Sealer } from './crypto.js';
import { db, disconnectDb } from './db.js';
import { logger } from './logger.js';
import { createQueue } from './lib/queue.js';
import { TokenVault } from './lib/tokens.js';
import { createRedis } from './redis.js';
import { startHealthServer } from './web/routes/health.js';
import { buildWebServer } from './web/server.js';
import { startWorker, type WorkerHandle } from './worker/worker.js';

const SHUTDOWN_TIMEOUT_MS = 20_000;

export async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const log = logger().child({ role: config.role, nodeId: config.nodeId });
  const prisma = db();
  const vault = new TokenVault(new Sealer(config.encryptionKey));
  const role = config.role;

  let webServer: Awaited<ReturnType<typeof buildWebServer>> | null = null;
  let workerHandle: WorkerHandle | null = null;
  let healthServer: Awaited<ReturnType<typeof startHealthServer>> | null = null;
  let redis: ReturnType<typeof createRedis> | null = null;

  const runsWeb = role === 'web' || role === 'both';
  const runsWorker = role === 'worker' || role === 'both';

  if (runsWeb) {
    redis = createRedis(config.redisUrl);
    const queue = createQueue(config.queueName, config.queueRedisUrl ?? config.redisUrl);
    webServer = await buildWebServer({ config, prisma, redis, queue, vault });
    await webServer.listen({ host: config.host, port: config.port });
    log.info({ port: config.port, appUrl: config.appUrl }, 'web server listening');
  }

  if (runsWorker) {
    workerHandle = await startWorker(config, prisma);
    // Worker-only nodes still need a probe target for Docker, the orchestrator
    // and uptime monitoring.
    if (!runsWeb) {
      redis = createRedis(config.redisUrl);
      healthServer = await startHealthServer({
        config,
        prisma,
        redis,
        startedAt: Date.now(),
        role,
        activeJobs: workerHandle.activeJobs,
      });
      log.info({ port: config.port }, 'worker health server listening');
    }
  }

  log.info(
    {
      chunkSize: config.chunkSizeBytes,
      concurrency: config.maxConcurrentJobs,
      bandwidthLimitBps: config.bandwidthLimitBps,
      ssrfAllowPrivate: config.ssrfAllowPrivate,
    },
    'service ready',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    // Hard deadline: an SSE stream or a wedged socket must not be able to keep
    // the container alive forever and block a rolling deploy.
    const hardExit = setTimeout(() => {
      log.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    hardExit.unref?.();

    try {
      // Stop accepting work before draining HTTP, so no new job is claimed
      // that we are about to abandon.
      await workerHandle?.stop();
      await healthServer?.close();
      await webServer?.close();
      redis?.disconnect();
      await disconnectDb();
      log.info('shutdown complete');
      clearTimeout(hardExit);
      process.exit(0);
    } catch (error) {
      log.error({ err: (error as Error).message }, 'error during shutdown');
      clearTimeout(hardExit);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    log.fatal({ err: error.message, stack: error.stack }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { getConfig };
