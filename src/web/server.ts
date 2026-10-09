import path from 'node:path';
import process from 'node:process';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { logger } from '../logger.js';
import { HttpError, TransferError } from '../lib/errors.js';
import { CancelNotifier, ProgressPublisher } from '../lib/progress.js';
import type { TransferJobData } from '../lib/queue.js';
import type { TokenVault } from '../lib/tokens.js';
import { createSubscriber } from '../redis.js';
import { readSession } from './auth.js';
import type { AppContext } from './context.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDriveRoutes } from './routes/drive.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerJobRoutes } from './routes/jobs.js';

export interface WebServerOptions {
  config: AppConfig;
  prisma: PrismaClient;
  redis: Redis;
  queue: Queue<TransferJobData>;
  vault: TokenVault;
  activeJobs?: () => number;
}

interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export async function buildWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const { config, prisma, redis, queue, vault } = options;

  const app = Fastify({
    // Cast keeps Fastify's TLogger generic at its default so the route modules
    // can accept a plain FastifyInstance; pino satisfies the interface at runtime.
    loggerInstance: logger().child({ component: 'web' }) as unknown as FastifyBaseLogger,
    // Behind Nginx/Caddy the real client address arrives in X-Forwarded-For;
    // rate limiting and audit logs are wrong without this.
    trustProxy: config.trustProxy,
    disableRequestLogging: config.nodeEnv === 'production',
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);

  // A shared Redis store is what makes the limit a fleet-wide limit. With the
  // default in-memory store, N web nodes would each allow `max` requests,
  // silently multiplying the intended cap.
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
    redis,
    // Authenticated users get per-account limits; anonymous ones per IP.
    keyGenerator: (request) => {
      const session = readSession(request, config);
      return session ? `user:${session.uid}` : `ip:${request.ip}`;
    },
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: 'RATE_LIMITED',
        message: `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
      },
    }),
  });

  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'public'),
    prefix: '/',
    index: ['index.html'],
    // The UI must never be cached after a deploy.
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('cache-control', 'no-cache');
      } else {
        res.setHeader('cache-control', 'public, max-age=300');
      }
    },
  });

  const publisher = new ProgressPublisher(redis);
  const ctx: AppContext = {
    config,
    prisma,
    vault,
    queue,
    publisher,
    cancelNotifier: new CancelNotifier(redis),
    subscriberFactory: () => createSubscriber(config.redisUrl),
  };

  registerHealthRoutes(app, {
    config,
    prisma,
    redis,
    startedAt: Date.now(),
    role: config.role,
    activeJobs: options.activeJobs,
  });

  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (request.url === '/' || request.url.endsWith('.html')) {
      void reply.header('x-frame-options', 'DENY');
    }
    if (config.corsOrigins.length > 0) {
      const origin = request.headers.origin;
      if (origin !== undefined && config.corsOrigins.includes(origin)) {
        void reply.header('access-control-allow-origin', origin);
        void reply.header('access-control-allow-credentials', 'true');
        void reply.header('vary', 'Origin');
      }
    }
    return payload;
  });

  app.options('/*', (request, reply) => {
    if (config.corsOrigins.length === 0) return reply.status(404).send();
    void reply.header('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    void reply.header('access-control-allow-headers', 'content-type,x-csrf-token');
    void reply.header('access-control-max-age', '600');
    return reply.status(204).send();
  });

  await registerAuthRoutes(app, ctx);
  await registerJobRoutes(app, ctx);
  await registerDriveRoutes(app, ctx);
  await registerEventRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);

  app.setNotFoundHandler((request, reply) => {
    // Unknown /api/* paths get JSON; anything else falls back to the SPA shell.
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send(errorBody('NOT_FOUND', 'Unknown endpoint'));
    }
    return reply.status(404).type('text/plain').send('Not found');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send(errorBody(error.code ?? 'ERROR', error.message));
    }
    if (error instanceof TransferError) {
      const status = error.code === 'CANCELLED' ? 409 : 400;
      return reply.status(status).send(errorBody(error.code, error.userMessage));
    }

    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status < 500) {
      const message = error instanceof Error ? error.message : String(error);
      if (status === 429) {
        return reply.status(429).send(errorBody('RATE_LIMITED', message));
      }
      return reply.status(status).send(errorBody('BAD_REQUEST', message));
    }

    request.log.error({ err: error }, 'unhandled request error');
    return reply.status(500).send(errorBody('INTERNAL', 'Internal server error'));
  });

  return app;
}
