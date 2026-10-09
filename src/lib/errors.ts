export type ErrorCode =
  | 'INVALID_URL'
  | 'SSRF_BLOCKED'
  | 'SOURCE_UNREACHABLE'
  | 'SOURCE_HTTP_ERROR'
  | 'SOURCE_TIMEOUT'
  | 'FILE_TOO_LARGE'
  | 'DRIVE_AUTH_FAILED'
  | 'DRIVE_QUOTA_EXCEEDED'
  | 'DRIVE_FOLDER_NOT_FOUND'
  | 'DRIVE_SESSION_EXPIRED'
  | 'DRIVE_ERROR'
  | 'CANCELLED'
  | 'LEASE_LOST'
  | 'INTERNAL';

/** Codes whose message is safe and useful to show verbatim in the UI. */
const USER_FACING: ReadonlySet<ErrorCode> = new Set([
  'INVALID_URL',
  'SSRF_BLOCKED',
  'SOURCE_UNREACHABLE',
  'SOURCE_HTTP_ERROR',
  'SOURCE_TIMEOUT',
  'FILE_TOO_LARGE',
  'DRIVE_AUTH_FAILED',
  'DRIVE_QUOTA_EXCEEDED',
  'DRIVE_FOLDER_NOT_FOUND',
  'CANCELLED',
]);

export interface TransferErrorOptions {
  retryable?: boolean;
  status?: number;
  userMessage?: string;
  cause?: unknown;
}

export class TransferError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly userMessage: string;

  constructor(code: ErrorCode, message: string, options: TransferErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TransferError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.userMessage =
      options.userMessage ?? (USER_FACING.has(code) ? message : 'Transfer failed. Please retry.');
  }

  toJSON(): { code: ErrorCode; message: string; retryable: boolean } {
    return { code: this.code, message: this.userMessage, retryable: this.retryable };
  }
}

export function isTransferError(error: unknown): error is TransferError {
  return error instanceof TransferError;
}

export function asTransferError(error: unknown): TransferError {
  if (isTransferError(error)) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new TransferError('CANCELLED', 'Transfer cancelled');
  }
  return new TransferError('INTERNAL', error instanceof Error ? error.message : String(error), {
    retryable: true,
    cause: error,
  });
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code?: string;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
