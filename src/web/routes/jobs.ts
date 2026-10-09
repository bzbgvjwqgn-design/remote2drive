import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { HttpError, TransferError } from '../../lib/errors.js';
import { enqueueTransfer } from '../../lib/queue.js';
import { serializeJob, serializeLogs, type JobDto } from '../../lib/serialize.js';
import { buildPolicy, resolveSafeTarget } from '../../lib/ssrf.js';
import type { AppContext } from '../context.js';
import { requireUser, verifyCsrf } from '../auth.js';

const urlItemSchema = z.object({
  url: z.string().min(1).max(4096),
  fileName: z.string().min(1).max(200).nullish(),
  folderId: z.string().min(1).max(200).nullish(),
});

/** Accepts either the rich form or a single-URL shorthand. */
const createBodySchema = z.union([
  z.object({ items: z.array(urlItemSchema).min(1) }),
  z.object({ urls: z.array(z.string().min(1).max(4096)).min(1), folderId: z.string().nullish() }),
  urlItemSchema,
]);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
  status: z.enum(['QUEUED', 'TRANSFERRING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
});

type UrlItem = z.infer<typeof urlItemSchema>;

function normalizeItems(body: z.infer<typeof createBodySchema>): UrlItem[] {
  if ('items' in body) return body.items;
  if ('urls' in body) {
    return body.urls.map((url) => ({ url, fileName: null, folderId: body.folderId ?? null }));
  }
  return [{ url: body.url, fileName: body.fileName ?? null, folderId: body.folderId ?? null }];
}

export interface PreflightFailure {
  url: string;
  code: string;
  reason: string;
}

/**
 * Rejects obviously-bad URLs at submit time so the user gets an immediate
 * answer instead of discovering it in the history page. Deliberately lenient
 * about DNS failures — a resolver hiccup should not block a valid submission,
 * and the worker re-validates everything anyway.
 */
export async function preflightUrls(
  urls: string[],
  policy: ReturnType<typeof buildPolicy>,
): Promise<{ passed: string[]; failures: PreflightFailure[] }> {
  const passed: string[] = [];
  const failures: PreflightFailure[] = [];

  for (const url of urls) {
    try {
      await resolveSafeTarget(url, { policy });
      passed.push(url);
    } catch (error) {
      if (error instanceof TransferError && (error.code === 'SSRF_BLOCKED' || error.code === 'INVALID_URL')) {
        failures.push({ url, code: error.code, reason: error.userMessage });
        continue;
      }
      // DNS/timeout: allow it through and let the worker decide.
      passed.push(url);
    }
  }
  return { passed, failures };
}

export async function registerJobRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config, prisma, queue, publisher, cancelNotifier } = ctx;

  const policy = buildPolicy({
    allowPrivate: config.ssrfAllowPrivate,
    extraBlocked: config.ssrfExtraBlockedCidrs,
    extraAllowed: config.ssrfExtraAllowedCidrs,
    allowedPorts: config.allowedPorts,
  });

  async function loadOwnedJob(jobId: string, userId: string) {
    const job = await prisma.job.findFirst({ where: { id: jobId, userId } });
    if (job === null) {
      // 404 rather than 403 so job ids cannot be probed for existence.
      throw new HttpError(404, 'Job not found', 'NOT_FOUND');
    }
    return job;
  }

  app.post(
    '/api/jobs',
    {
      config: {
        // Much tighter than the global limit: this endpoint is what actually
        // consumes bandwidth and Drive quota.
        rateLimit: { max: config.jobSubmitRateMax, timeWindow: config.jobSubmitRateWindow },
      },
    },
    async (request, reply) => {
    verifyCsrf(request);
    const session = requireUser(request, config);

    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, `Invalid request: ${parsed.error.issues.map((i) => i.message).join(', ')}`, 'VALIDATION');
    }

    const account = await prisma.googleAccount.findUnique({ where: { userId: session.uid } });
    if (account === null) {
      throw new HttpError(409, 'Connect your Google Drive before submitting URLs', 'NOT_CONNECTED');
    }

    const items = normalizeItems(parsed.data);
    if (items.length > config.maxUrlsPerRequest) {
      throw new HttpError(
        400,
        `At most ${config.maxUrlsPerRequest} URLs per request (got ${items.length})`,
        'TOO_MANY_URLS',
      );
    }

    const activeCount = await prisma.job.count({
      where: { userId: session.uid, status: { in: ['QUEUED', 'TRANSFERRING'] } },
    });
    const room = config.maxActiveJobsPerUser - activeCount;
    if (room <= 0) {
      throw new HttpError(
        429,
        `You already have ${activeCount} active jobs (limit ${config.maxActiveJobsPerUser})`,
        'TOO_MANY_ACTIVE_JOBS',
      );
    }
    if (items.length > room) {
      throw new HttpError(
        429,
        `Only ${room} more concurrent job(s) allowed; submitted ${items.length}`,
        'TOO_MANY_ACTIVE_JOBS',
      );
    }

    // Reject duplicates within one submission so a pasted list is not charged twice.
    const seen = new Set<string>();
    const unique: UrlItem[] = [];
    const failures: PreflightFailure[] = [];
    for (const item of items) {
      const normalized = item.url.trim();
      if (seen.has(normalized)) {
        failures.push({ url: normalized, code: 'DUPLICATE_IN_BATCH', reason: 'URL appears more than once in this request' });
        continue;
      }
      seen.add(normalized);
      unique.push({ ...item, url: normalized });
    }

    const preflight = await preflightUrls(
      unique.map((i) => i.url),
      policy,
    );
    const blocked = new Set(preflight.failures.map((f) => f.url));
    failures.push(...preflight.failures);

    const accepted = unique.filter((item) => !blocked.has(item.url));
    const batchId = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const created = await prisma.$transaction(
      accepted.map((item) =>
        prisma.job.create({
          data: {
            userId: session.uid,
            batchId,
            sourceUrl: item.url,
            fileName: item.fileName ?? null,
            folderId: item.folderId ?? config.driveRootFolderId ?? null,
            status: 'QUEUED',
            phase: 'queued',
            maxAttempts: config.maxAttempts,
            nextAttemptAt: new Date(),
          } satisfies Prisma.JobCreateInput | Prisma.JobUncheckedCreateInput,
        }),
      ),
    );

    for (const job of created) {
      await enqueueTransfer(queue, { jobId: job.id, userId: job.userId, attempt: job.attempts });
    }

    reply.status(202);
    return {
      batchId,
      accepted: created.map((job) => serializeJob(job)),
      rejected: failures,
      limits: { active: activeCount + created.length, max: config.maxActiveJobsPerUser },
    };
    },
  );

  app.get('/api/jobs', async (request) => {
    const session = requireUser(request, config);
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new HttpError(400, 'Invalid pagination parameters', 'VALIDATION');
    const { limit, cursor, status } = parsed.data;

    let cursorAt: Date | undefined;
    if (cursor !== undefined) {
      const anchor = await prisma.job.findFirst({
        where: { id: cursor, userId: session.uid },
        select: { queuedAt: true },
      });
      cursorAt = anchor?.queuedAt;
    }

    const where: Prisma.JobWhereInput = {
      userId: session.uid,
      ...(status !== undefined ? { status } : {}),
      ...(cursorAt !== undefined ? { queuedAt: { lt: cursorAt } } : {}),
    };

    const jobs = await prisma.job.findMany({
      where,
      orderBy: { queuedAt: 'desc' },
      take: limit + 1,
    });

    const live = await publisher.snapshot(jobs.map((j) => j.id));
    const page = jobs.slice(0, limit);
    const dto: JobDto[] = page.map((job) => serializeJob(job, live.get(job.id) ?? null));

    return {
      jobs: dto,
      nextCursor: jobs.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });

  app.get('/api/jobs/:id', async (request) => {
    const session = requireUser(request, config);
    const { id } = request.params as { id: string };
    const job = await loadOwnedJob(id, session.uid);
    const logs = await prisma.jobLog.findMany({
      where: { jobId: job.id },
      orderBy: { at: 'asc' },
      take: 200,
    });
    const live = await publisher.snapshot([job.id]);
    return { job: serializeJob(job, live.get(job.id) ?? null), logs: serializeLogs(logs) };
  });

  app.post('/api/jobs/:id/cancel', async (request) => {
    verifyCsrf(request);
    const session = requireUser(request, config);
    const { id } = request.params as { id: string };
    const job = await loadOwnedJob(id, session.uid);

    if (job.status === 'COMPLETED' || job.status === 'CANCELLED' || job.status === 'FAILED') {
      throw new HttpError(409, `Job is already ${job.status.toLowerCase()}`, 'INVALID_STATE');
    }

    // Marking the row first means the worker's own status poll sees the cancel
    // even if the pub/sub message is lost.
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'CANCELLED', phase: null, finishedAt: new Date(), errorCode: 'CANCELLED', errorMessage: 'Cancelled by user' },
    });
    await cancelNotifier.request(job.id);

    const live = await publisher.snapshot([job.id]);
    const updated = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    return { job: serializeJob(updated, live.get(job.id) ?? null) };
  });

  app.post('/api/jobs/:id/retry', async (request) => {
    verifyCsrf(request);
    const session = requireUser(request, config);
    const { id } = request.params as { id: string };
    const job = await loadOwnedJob(id, session.uid);

    if (job.status !== 'FAILED' && job.status !== 'CANCELLED') {
      throw new HttpError(409, 'Only failed or cancelled jobs can be retried', 'INVALID_STATE');
    }

    const activeCount = await prisma.job.count({
      where: { userId: session.uid, status: { in: ['QUEUED', 'TRANSFERRING'] } },
    });
    if (activeCount >= config.maxActiveJobsPerUser) {
      throw new HttpError(429, 'Active job limit reached; wait for a slot', 'TOO_MANY_ACTIVE_JOBS');
    }

    // `attempts` keeps climbing so BullMQ job ids stay unique, while raising
    // `maxAttempts` hands the job a fresh retry budget instead of instantly
    // re-failing on the exhaustion check.
    const updated = await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'QUEUED',
        phase: 'queued',
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        nextAttemptAt: new Date(),
        maxAttempts: job.attempts + config.maxAttempts,
        queuedAt: new Date(),
      },
    });
    await prisma.jobLog.create({
      data: { jobId: job.id, level: 'info', event: 'manual_retry', message: 'requeued by user' },
    });
    await enqueueTransfer(queue, { jobId: job.id, userId: job.userId, attempt: job.attempts });

    return { job: serializeJob(updated) };
  });

  app.delete('/api/jobs/:id', async (request) => {
    verifyCsrf(request);
    const session = requireUser(request, config);
    const { id } = request.params as { id: string };
    const job = await loadOwnedJob(id, session.uid);

    if (job.status === 'QUEUED' || job.status === 'TRANSFERRING') {
      await cancelNotifier.request(job.id);
    }
    await prisma.job.delete({ where: { id: job.id } });
    return { ok: true, id: job.id };
  });
}
