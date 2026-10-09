import type { FastifyInstance } from 'fastify';
import { ProgressSubscription } from '../../lib/progress.js';
import { serializeJob } from '../../lib/serialize.js';
import type { AppContext } from '../context.js';
import { requireUser } from '../auth.js';

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events rather than WebSocket: progress is strictly
 * server-to-client, SSE survives plain HTTP/1.1 proxies and reconnects
 * natively in the browser, and it needs no extra dependency.
 *
 * Each open stream owns one Redis subscriber connection, so this endpoint is
 * the only thing that scales with concurrent browsers rather than with nodes.
 */
export async function registerEventRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config, prisma, publisher } = ctx;

  app.get('/api/events', async (request, reply) => {
    const session = requireUser(request, config);
    const redis = ctx.subscriberFactory();

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Disable intermediary buffering (nginx honours this, Caddy uses
      // flush_interval -1 which is set in the sample config).
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let subscription: ProgressSubscription | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let closed = false;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      subscription?.close();
      raw.end();
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    try {
      subscription = await ProgressSubscription.open(redis, session.uid);
      subscription.onEvent((event) => {
        if (!closed) send('progress', event);
      });

      // Catch the client up on anything that changed while it was disconnected.
      const active = await prisma.job.findMany({
        where: { userId: session.uid, status: { in: ['QUEUED', 'TRANSFERRING'] } },
        orderBy: { queuedAt: 'desc' },
        take: 100,
      });
      const live = await publisher.snapshot(active.map((job) => job.id));
      send('snapshot', {
        jobs: active.map((job) => serializeJob(job, live.get(job.id) ?? null)),
      });

      heartbeat = setInterval(() => {
        if (!closed) raw.write(': ping\n\n');
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
    } catch (error) {
      request.log.error({ err: (error as Error).message }, 'SSE setup failed');
      send('error', { message: 'Unable to open progress stream' });
      cleanup();
    }
  });
}
