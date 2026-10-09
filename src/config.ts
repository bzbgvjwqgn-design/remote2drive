import crypto from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';

export const CHUNK_ALIGNMENT = 256 * 1024;

const boolish = z
  .string()
  .trim()
  .transform((v) => ['true', '1', 'yes', 'on'].includes(v.toLowerCase()))
  .pipe(z.boolean());

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const csvNumbers = csv.pipe(
  z.array(z.coerce.number().int().min(0).max(65535)).transform((v) => v),
);

const optionalNonEmpty = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? undefined : v));

/** Accepts 64 hex chars or base64; always yields exactly 32 bytes. */
const aes256Key = z.string().superRefine((raw, ctx) => {
  const bytes = decodeKeyMaterial(raw);
  if (bytes === null || bytes.length !== 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes (64 hex chars or 44 base64 chars). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    });
  }
});

function decodeKeyMaterial(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const buf = Buffer.from(trimmed, 'base64');
    // Reject the silent "" that Buffer.from returns for non-base64 input.
    if (buf.length > 0 && buf.toString('base64').replace(/=+$/, '') === trimmed.replace(/=+$/, '')) {
      return buf;
    }
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

const schema = z.object({
  role: z.enum(['web', 'worker', 'both']).default('both'),
  nodeEnv: z.enum(['development', 'test', 'production']).default('production'),
  host: z.string().min(1).default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65535).default(8080),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  appUrl: z.string().url().transform((v) => v.replace(/\/+$/, '')),
  nodeId: optionalNonEmpty,
  appVersion: z.string().default('1.0.0'),
  adminEmails: csv.default(''),

  sessionSecret: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  tokenEncryptionKey: aes256Key,

  googleClientId: z.string().min(1),
  googleClientSecret: z.string().min(1),
  googleRedirectUri: optionalNonEmpty,

  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  queueRedisUrl: optionalNonEmpty,

  queueName: z.string().min(1).default('transfer'),
  maxConcurrentJobs: z.coerce.number().int().min(1).max(256).default(4),
  jobTimeoutMs: z.coerce.number().int().min(10_000).default(3_600_000),
  leaseTtlMs: z.coerce.number().int().min(5_000).default(60_000),
  leaseHeartbeatMs: z.coerce.number().int().min(1_000).default(20_000),
  leaseReaperIntervalMs: z.coerce.number().int().min(1_000).default(15_000),
  maxAttempts: z.coerce.number().int().min(1).max(50).default(5),
  retryBaseDelayMs: z.coerce.number().int().min(100).default(5_000),
  retryMaxDelayMs: z.coerce.number().int().min(1_000).default(900_000),
  workerLockDurationMs: z.coerce.number().int().min(5_000).default(120_000),

  chunkSizeBytes: z.coerce
    .number()
    .int()
    .min(CHUNK_ALIGNMENT)
    .default(16 * 1024 * 1024)
    .transform((v) => Math.max(CHUNK_ALIGNMENT, Math.floor(v / CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT)),

  maxFileSizeBytes: z.coerce.number().int().min(0).default(0),
  maxActiveJobsPerUser: z.coerce.number().int().min(1).default(5),
  maxUrlsPerRequest: z.coerce.number().int().min(1).max(500).default(20),
  bandwidthLimitBps: z.coerce.number().int().min(0).default(0),
  onDuplicate: z.enum(['rename', 'allow']).default('rename'),
  driveRootFolderId: optionalNonEmpty,

  maxRedirects: z.coerce.number().int().min(0).max(20).default(5),
  allowedPorts: csvNumbers.default('80,443'),
  connectTimeoutMs: z.coerce.number().int().min(500).default(15_000),
  idleTimeoutMs: z.coerce.number().int().min(1_000).default(60_000),
  requestTimeoutMs: z.coerce.number().int().min(1_000).default(900_000),
  userAgent: z.string().min(1).default('remote-to-drive/1.0'),

  ssrfAllowPrivate: boolish.default('false'),
  ssrfExtraBlockedCidrs: csv.default(''),
  ssrfExtraAllowedCidrs: csv.default(''),

  trustProxy: boolish.default('true'),
  rateLimitMax: z.coerce.number().int().min(1).default(300),
  rateLimitWindow: z.string().default('60 seconds'),
  jobSubmitRateMax: z.coerce.number().int().min(1).default(20),
  jobSubmitRateWindow: z.string().default('10 minutes'),
  corsOrigins: csv.default(''),
});

export type AppConfig = z.infer<typeof schema> & {
  nodeId: string;
  googleRedirectUri: string;
  encryptionKey: Buffer;
};

const ENV_MAP: Record<string, string> = {
  role: 'ROLE',
  nodeEnv: 'NODE_ENV',
  host: 'HOST',
  port: 'PORT',
  logLevel: 'LOG_LEVEL',
  appUrl: 'APP_URL',
  nodeId: 'NODE_ID',
  appVersion: 'APP_VERSION',
  adminEmails: 'ADMIN_EMAILS',
  sessionSecret: 'SESSION_SECRET',
  tokenEncryptionKey: 'TOKEN_ENCRYPTION_KEY',
  googleClientId: 'GOOGLE_CLIENT_ID',
  googleClientSecret: 'GOOGLE_CLIENT_SECRET',
  googleRedirectUri: 'GOOGLE_REDIRECT_URI',
  databaseUrl: 'DATABASE_URL',
  redisUrl: 'REDIS_URL',
  queueRedisUrl: 'QUEUE_REDIS_URL',
  queueName: 'QUEUE_NAME',
  maxConcurrentJobs: 'MAX_CONCURRENT_JOBS',
  jobTimeoutMs: 'JOB_TIMEOUT_MS',
  leaseTtlMs: 'LEASE_TTL_MS',
  leaseHeartbeatMs: 'LEASE_HEARTBEAT_MS',
  leaseReaperIntervalMs: 'LEASE_REAPER_INTERVAL_MS',
  maxAttempts: 'MAX_ATTEMPTS',
  retryBaseDelayMs: 'RETRY_BASE_DELAY_MS',
  retryMaxDelayMs: 'RETRY_MAX_DELAY_MS',
  workerLockDurationMs: 'WORKER_LOCK_DURATION_MS',
  chunkSizeBytes: 'CHUNK_SIZE_BYTES',
  maxFileSizeBytes: 'MAX_FILE_SIZE_BYTES',
  maxActiveJobsPerUser: 'MAX_ACTIVE_JOBS_PER_USER',
  maxUrlsPerRequest: 'MAX_URLS_PER_REQUEST',
  bandwidthLimitBps: 'BANDWIDTH_LIMIT_BPS',
  onDuplicate: 'ON_DUPLICATE',
  driveRootFolderId: 'DRIVE_ROOT_FOLDER_ID',
  maxRedirects: 'MAX_REDIRECTS',
  allowedPorts: 'ALLOWED_PORTS',
  connectTimeoutMs: 'CONNECT_TIMEOUT_MS',
  idleTimeoutMs: 'IDLE_TIMEOUT_MS',
  requestTimeoutMs: 'REQUEST_TIMEOUT_MS',
  userAgent: 'USER_AGENT',
  ssrfAllowPrivate: 'SSRF_ALLOW_PRIVATE',
  ssrfExtraBlockedCidrs: 'SSRF_EXTRA_BLOCKED_CIDRS',
  ssrfExtraAllowedCidrs: 'SSRF_EXTRA_ALLOWED_CIDRS',
  trustProxy: 'TRUST_PROXY',
  rateLimitMax: 'RATE_LIMIT_MAX',
  rateLimitWindow: 'RATE_LIMIT_WINDOW',
  jobSubmitRateMax: 'JOB_SUBMIT_RATE_MAX',
  jobSubmitRateWindow: 'JOB_SUBMIT_RATE_WINDOW',
  corsOrigins: 'CORS_ORIGINS',
};

function projectEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, envName] of Object.entries(ENV_MAP)) {
    const value = env[envName];
    if (value !== undefined) out[key] = value;
  }
  // CHUNK_SIZE_MB is the documented knob; CHUNK_SIZE_BYTES wins if both are set.
  if (out.chunkSizeBytes === undefined && env.CHUNK_SIZE_MB !== undefined) {
    const mb = Number(env.CHUNK_SIZE_MB);
    if (Number.isFinite(mb) && mb > 0) out.chunkSizeBytes = Math.round(mb * 1024 * 1024);
  }
  if (out.allowedPorts === undefined) out.allowedPorts = env.ALLOWED_PORTS ?? '80,443';
  return out;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(projectEnv(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${ENV_MAP[i.path[0] ?? ''] ?? i.path.join('.')}: ${i.message}`,
    );
    throw new ConfigError(issues);
  }
  const base = parsed.data;
  const encryptionKey = decodeKeyMaterial(base.tokenEncryptionKey);
  if (encryptionKey === null || encryptionKey.length !== 32) {
    throw new ConfigError(['TOKEN_ENCRYPTION_KEY did not decode to 32 bytes']);
  }
  return {
    ...base,
    nodeId: base.nodeId ?? `${os.hostname()}-${base.role}-${process.pid}`,
    googleRedirectUri: base.googleRedirectUri ?? `${base.appUrl}/auth/google/callback`,
    encryptionKey,
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached === null) cached = loadConfig();
  return cached;
}

/** Test hook: install a config without touching process.env. */
export function setConfigForTest(config: AppConfig): void {
  cached = config;
}

export function randomTokenId(): string {
  return crypto.randomBytes(16).toString('hex');
}
