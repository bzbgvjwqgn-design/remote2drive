import http from 'node:http';
import https from 'node:https';
import { Transform, type Readable } from 'node:stream';
import { TransferError } from './errors.js';
import {
  pinnedLookup,
  resolveSafeTarget,
  type ResolvedTarget,
  type SsrfPolicy,
} from './ssrf.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface RemoteRequestOptions {
  policy: SsrfPolicy;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirects?: number;
  idleTimeoutMs?: number;
  userAgent?: string;
  /** Test seam: replaces real DNS while keeping the rest of the path intact. */
  lookup?: (hostname: string) => Promise<string[]>;
}

export interface RemoteResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Readable;
  finalUrl: string;
  redirectChain: string[];
  target: ResolvedTarget;
  /** Always call this: it destroys the socket and the per-request agent. */
  release: () => void;
}

function agentFor(target: ResolvedTarget): http.Agent {
  const options = {
    keepAlive: false,
    // We resolved and vetted the address already; never let the socket ask DNS
    // again, or the name can be re-bound to an internal IP in between.
    autoSelectFamily: false,
    lookup: pinnedLookup(target),
  } as unknown as https.AgentOptions;

  return target.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options);
}

function describeSocketError(cause: Error, target: ResolvedTarget): TransferError {
  const code = (cause as NodeJS.ErrnoException).code ?? '';
  const where = `${target.hostname}:${target.port}`;

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || cause.name === 'AbortError') {
    return new TransferError('SOURCE_TIMEOUT', `Timed out contacting ${where}`, {
      retryable: true,
      cause,
    });
  }
  if (code.startsWith('ERR_TLS') || code.startsWith('UNABLE_TO_VERIFY') || code.includes('CERT')) {
    return new TransferError(
      'SOURCE_UNREACHABLE',
      `TLS verification failed for ${where}: ${code || cause.message}`,
      { cause },
    );
  }
  return new TransferError(
    'SOURCE_UNREACHABLE',
    `Could not reach ${where}${code ? ` (${code})` : ''}: ${cause.message}`,
    { retryable: true, cause },
  );
}

interface IssueResult {
  res: http.IncomingMessage;
  agent: http.Agent;
}

function issue(target: ResolvedTarget, options: RemoteRequestOptions): Promise<IssueResult> {
  return new Promise<IssueResult>((resolve, reject) => {
    const library = target.protocol === 'https:' ? https : http;
    const agent = agentFor(target);
    const path = `${target.url.pathname}${target.url.search}`;

    const req = library.request(
      {
        protocol: target.protocol,
        // `hostname` stays the real name so TLS SNI and certificate
        // verification work; only the address lookup is pinned.
        hostname: target.hostname,
        port: target.port,
        path,
        method: options.method ?? 'GET',
        agent,
        signal: options.signal,
        headers: {
          'user-agent': options.userAgent ?? 'remote-to-drive/1.0',
          accept: '*/*',
          connection: 'close',
          ...options.headers,
        },
      },
      (res) => resolve({ res, agent }),
    );

    req.setTimeout(options.idleTimeoutMs ?? 60_000, () => {
      req.destroy(new Error('socket idle timeout'));
    });
    req.on('error', (cause) => {
      agent.destroy();
      reject(describeSocketError(cause as Error, target));
    });
    req.end();
  });
}

/**
 * Performs a GET/HEAD with SSRF validation re-applied at every redirect hop.
 * The caller owns the returned stream and must call `release()`.
 */
export async function fetchRemote(
  rawUrl: string,
  options: RemoteRequestOptions,
): Promise<RemoteResponse> {
  const maxRedirects = options.maxRedirects ?? 5;
  const chain: string[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const target = await resolveSafeTarget(current, {
      policy: options.policy,
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });

    const { res, agent } = await issue(target, options);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    const release = () => {
      res.destroy();
      agent.destroy();
    };

    if (REDIRECT_STATUSES.has(status) && location !== undefined) {
      if (hop === maxRedirects) {
        release();
        throw new TransferError(
          'SOURCE_UNREACHABLE',
          `Too many redirects (>${maxRedirects}) starting from ${rawUrl}`,
        );
      }
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        release();
        throw new TransferError('SOURCE_UNREACHABLE', `Malformed Location header: ${location}`);
      }
      // Drain the small redirect body so the socket can close cleanly.
      res.resume();
      agent.destroy();
      chain.push(next);
      current = next;
      continue;
    }

    return {
      status,
      headers: res.headers,
      body: res,
      finalUrl: current,
      redirectChain: chain,
      target,
      release,
    };
  }

  throw new TransferError('SOURCE_UNREACHABLE', `Too many redirects (>${maxRedirects})`);
}

/** Reads at most `limit` bytes of a body for error diagnostics, then discards it. */
export async function readBodySnippet(body: Readable, limit = 4096): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const buf = chunk as Buffer;
      chunks.push(buf);
      total += buf.length;
      if (total >= limit) break;
    }
  } catch {
    // A truncated diagnostic body is not worth failing over.
  } finally {
    body.destroy();
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8').trim();
}

export class BodyTooLargeError extends TransferError {
  constructor(limit: number, seen: number) {
    super(
      'FILE_TOO_LARGE',
      `Stream exceeded the ${limit} byte limit after ${seen} bytes`,
      { userMessage: `File is larger than the ${formatBytes(limit)} limit.` },
    );
    this.name = 'BodyTooLargeError';
  }
}

/** Enforces a size cap on streams with a missing or lying Content-Length. */
export function byteLimiter(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buf = chunk as Buffer;
      seen += buf.length;
      if (maxBytes > 0 && seen > maxBytes) {
        callback(new BodyTooLargeError(maxBytes, seen));
        return;
      }
      callback(null, buf);
    },
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}
