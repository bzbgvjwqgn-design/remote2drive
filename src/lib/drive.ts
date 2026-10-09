import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { CHUNK_ALIGNMENT } from '../config.js';
import { TransferError } from './errors.js';

export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';
export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Google requires every chunk except the final one to be a multiple of
 * 256 KiB. Flooring keeps an operator-supplied value like "10 MB" legal
 * instead of silently producing rejected uploads.
 */
export function alignChunkSize(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return CHUNK_ALIGNMENT;
  const aligned = Math.floor(bytes / CHUNK_ALIGNMENT) * CHUNK_ALIGNMENT;
  return aligned < CHUNK_ALIGNMENT ? CHUNK_ALIGNMENT : aligned;
}

export interface DriveTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
}

export interface RawHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export function httpRequest(options: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string | number>;
  body?: Buffer | string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(options.url);
    } catch (cause) {
      reject(new TransferError('DRIVE_ERROR', `Malformed Drive URL: ${options.url}`, { cause }));
      return;
    }

    const payload =
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? Buffer.from(options.body, 'utf8')
          : options.body;

    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: {
          ...(payload !== undefined ? { 'content-length': payload.length } : {}),
          ...options.headers,
        },
        signal: options.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );

    req.setTimeout(options.timeoutMs ?? 120_000, () => {
      req.destroy(new Error('Drive request timed out'));
    });
    req.on('error', (cause) => {
      const code = (cause as NodeJS.ErrnoException).code ?? '';
      if (cause.name === 'AbortError') {
        reject(new TransferError('CANCELLED', 'Drive request aborted'));
        return;
      }
      reject(
        new TransferError('DRIVE_ERROR', `Drive request failed${code ? ` (${code})` : ''}: ${cause.message}`, {
          retryable: true,
          cause,
        }),
      );
    });

    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface DriveErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string; domain?: string }>;
  };
}

/** Translates a Drive error payload into a typed, retry-classified failure. */
export function mapDriveError(status: number, body: Buffer, context: string): TransferError {
  let parsed: DriveErrorBody = {};
  try {
    parsed = JSON.parse(body.toString('utf8')) as DriveErrorBody;
  } catch {
    parsed = {};
  }
  const error = parsed.error;
  const reasons = (error?.errors ?? []).map((e) => e.reason ?? '').filter((r) => r !== '');
  const message = error?.message ?? body.toString('utf8').slice(0, 300) ?? `HTTP ${status}`;
  const reason = reasons[0] ?? error?.status ?? '';

  if (status === 401 || status === 403 && /auth|credential|token/i.test(reason)) {
    return new TransferError('DRIVE_AUTH_FAILED', `${context}: ${message}`, {
      status,
      userMessage:
        'Google rejected the stored authorization. Please sign out and connect your Drive again.',
    });
  }
  if (status === 403 || status === 429) {
    if (/quota|storage|insufficient/i.test(reason) || /quota/i.test(message)) {
      return new TransferError('DRIVE_QUOTA_EXCEEDED', `${context}: ${message}`, {
        status,
        userMessage:
          'Your Google Drive storage is full. Free up space (or empty Drive trash) and retry.',
      });
    }
    return new TransferError('DRIVE_ERROR', `${context}: rate limited (${reason || status})`, {
      status,
      retryable: true,
    });
  }
  if (status === 404) {
    return new TransferError('DRIVE_FOLDER_NOT_FOUND', `${context}: ${message}`, {
      status,
      userMessage: 'The target Drive folder no longer exists or is not shared with this account.',
    });
  }
  if (status === 400) {
    return new TransferError('DRIVE_ERROR', `${context}: ${message}`, { status });
  }
  if (status >= 500 || status === 429) {
    return new TransferError('DRIVE_ERROR', `${context}: upstream ${status}`, {
      status,
      retryable: true,
    });
  }
  return new TransferError('DRIVE_ERROR', `${context}: ${message}`, { status });
}

export interface SessionOptions {
  name: string;
  mimeType: string;
  parentFolderId?: string | null;
  /** Omit when the source did not advertise Content-Length. */
  totalBytes?: number | null;
  description?: string;
}

export interface ChunkResult {
  /** 200/201 means Drive accepted the whole file and returned metadata. */
  complete: boolean;
  /** Bytes Drive confirms it holds, parsed from the 308 Range header. */
  offset: number;
  status: number;
  file?: DriveFile;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  webViewLink?: string;
  webContentLink?: string;
}

/** `Range: bytes=0-99` -> 100. A missing Range on a 308 means nothing landed. */
export function parseRangeOffset(header: string | undefined): number {
  if (!header) return 0;
  const match = /bytes=(\d*)-(\d*)/i.exec(header);
  if (!match) return 0;
  const end = match[2];
  if (end === undefined || end === '') return 0;
  return Number(end) + 1;
}

export function buildContentRange(
  start: number,
  length: number,
  totalBytes: number | null,
  isLast: boolean,
): string {
  const end = start + length - 1;
  if (totalBytes !== null && totalBytes !== undefined) {
    return `bytes ${start}-${end}/${totalBytes}`;
  }
  // Unknown length: every intermediate chunk uses "*", and the final chunk is
  // what declares the real total — that is how Drive learns the upload ended.
  return isLast ? `bytes ${start}-${end}/${end + 1}` : `bytes ${start}-${end}/*`;
}

export class DriveClient {
  private readonly auth: OAuth2Client;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    refreshToken: string,
    private readonly onTokens?: (tokens: { refreshToken?: string | null; expiresAt?: Date | null }) => Promise<void> | void,
  ) {
    this.auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    this.auth.setCredentials({ refresh_token: refreshToken });
    this.auth.on('tokens', (tokens) => {
      // Google rotates refresh tokens; persisting the new one is what keeps a
      // long-lived account linked.
      void this.onTokens?.({
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      });
    });
  }

  /** Returns a valid access token, refreshing (and caching) as needed. */
  async accessToken(): Promise<string> {
    if (this.cachedToken !== null && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.value;
    }
    try {
      const result = await this.auth.getAccessToken();
      const token = typeof result === 'string' ? result : result.token;
      if (!token) throw new Error('no access token returned');
      const credentials = this.auth.credentials;
      const expiry = credentials.expiry_date ?? Date.now() + 3_600_000;
      this.cachedToken = { value: token, expiresAt: expiry };
      return token;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new TransferError(
        'DRIVE_AUTH_FAILED',
        `Unable to refresh Google access token: ${message}`,
        {
          userMessage:
            'Your Google connection has expired or was revoked. Sign out and connect Drive again.',
          cause,
        },
      );
    }
  }

  /**
   * Opens a resumable session. The returned URI is a bearer credential for the
   * upload, so callers must encrypt it before persisting.
   */
  async createUploadSession(options: SessionOptions, signal?: AbortSignal): Promise<string> {
    const token = await this.accessToken();
    const metadata: Record<string, unknown> = {
      name: options.name,
      mimeType: options.mimeType,
    };
    if (options.parentFolderId) metadata.parents = [options.parentFolderId];
    if (options.description) metadata.description = options.description;

    const url = `${DRIVE_UPLOAD_BASE}?uploadType=resumable&supportsAllDrives=true`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': options.mimeType,
    };
    if (options.totalBytes !== null && options.totalBytes !== undefined) {
      headers['x-upload-content-length'] = String(options.totalBytes);
    }

    const response = await httpRequest({
      method: 'POST',
      url,
      headers,
      body: JSON.stringify(metadata),
      signal,
    });

    if (response.status !== 200 && response.status !== 201) {
      throw mapDriveError(response.status, response.body, 'createUploadSession');
    }
    const location = response.headers.location;
    if (!location) {
      throw new TransferError(
        'DRIVE_ERROR',
        'Drive did not return a resumable session Location header',
        { retryable: true },
      );
    }
    return location;
  }

  /**
   * Asks Drive how many bytes of this session it already holds. This is the
   * anchor for resuming: the download is reopened from exactly this offset so
   * no byte is fetched twice and none is skipped.
   */
  async querySessionOffset(
    sessionUri: string,
    totalBytes: number | null,
    signal?: AbortSignal,
  ): Promise<{ offset: number; complete: boolean; file?: DriveFile }> {
    const wildcard = totalBytes === null ? '*' : String(totalBytes);
    const response = await httpRequest({
      method: 'PUT',
      url: sessionUri,
      headers: { 'content-length': 0, 'content-range': `bytes */${wildcard}` },
      signal,
    });

    if (response.status === 200 || response.status === 201) {
      return { offset: totalBytes ?? 0, complete: true, file: safeParseFile(response.body) };
    }
    if (response.status === 308) {
      return { offset: parseRangeOffset(response.headers.range as string | undefined), complete: false };
    }
    if (response.status === 404) {
      // Sessions expire (a week of inactivity) or are dropped after errors.
      throw new TransferError(
        'DRIVE_SESSION_EXPIRED',
        'Resumable upload session no longer exists',
        { retryable: true },
      );
    }
    throw mapDriveError(response.status, response.body, 'querySessionOffset');
  }

  /** Sends one chunk. Never throws on 308 — that is the normal in-flight case. */
  async uploadChunk(
    sessionUri: string,
    start: number,
    chunk: Buffer,
    totalBytes: number | null,
    isLast: boolean,
    signal?: AbortSignal,
  ): Promise<ChunkResult> {
    const response = await httpRequest({
      method: 'PUT',
      url: sessionUri,
      headers: {
        'content-length': chunk.length,
        'content-range': buildContentRange(start, chunk.length, totalBytes, isLast),
      },
      body: chunk,
      signal,
      timeoutMs: 300_000,
    });

    if (response.status === 200 || response.status === 201) {
      const file = safeParseFile(response.body);
      if (file === undefined) {
        throw new TransferError(
          'DRIVE_ERROR',
          'Drive reported success but returned no file metadata',
          { retryable: true },
        );
      }
      return { complete: true, offset: start + chunk.length, status: response.status, file };
    }
    if (response.status === 308) {
      return {
        complete: false,
        offset: parseRangeOffset(response.headers.range as string | undefined),
        status: 308,
      };
    }
    if (response.status === 404) {
      throw new TransferError('DRIVE_SESSION_EXPIRED', 'Upload session expired mid-transfer', {
        retryable: true,
      });
    }
    throw mapDriveError(response.status, response.body, 'uploadChunk');
  }

  async listFolders(pageSize = 200, signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
    const token = await this.accessToken();
    const query = new URLSearchParams({
      q: `mimeType='${FOLDER_MIME}' and trashed=false`,
      fields: 'files(id,name)',
      pageSize: String(pageSize),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      orderBy: 'name',
    });
    const response = await httpRequest({
      method: 'GET',
      url: `${DRIVE_API_BASE}?${query.toString()}`,
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (response.status !== 200) throw mapDriveError(response.status, response.body, 'listFolders');
    const parsed = JSON.parse(response.body.toString('utf8')) as {
      files?: Array<{ id: string; name: string }>;
    };
    return parsed.files ?? [];
  }

  /** True when a live file with this exact name already sits in the folder. */
  async nameExists(
    name: string,
    folderId: string | null | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const token = await this.accessToken();
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const clauses = [`name = '${escaped}'`, "trashed = false"];
    if (folderId) clauses.push(`'${folderId.replace(/'/g, '')}' in parents`);

    const query = new URLSearchParams({
      q: clauses.join(' and '),
      fields: 'files(id)',
      pageSize: '1',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const response = await httpRequest({
      method: 'GET',
      url: `${DRIVE_API_BASE}?${query.toString()}`,
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    if (response.status !== 200) throw mapDriveError(response.status, response.body, 'nameExists');
    const parsed = JSON.parse(response.body.toString('utf8')) as { files?: unknown[] };
    return (parsed.files ?? []).length > 0;
  }
}

function safeParseFile(body: Buffer): DriveFile | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as DriveFile;
    return typeof parsed?.id === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
