import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { constantTimeEqual, randomHex, signSession, verifySession, type SessionPayload } from '../crypto.js';

export const SESSION_COOKIE = 'r2d_session';
export const CSRF_COOKIE = 'r2d_csrf';
export const OAUTH_STATE_COOKIE = 'r2d_oauth_state';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

/** Cookies are only marked Secure when the app believes it is behind TLS. */
function isSecure(request: FastifyRequest): boolean {
  if (request.protocol === 'https') return true;
  const forwarded = request.headers['x-forwarded-proto'];
  return forwarded === 'https';
}

export function issueSession(
  reply: FastifyReply,
  request: FastifyRequest,
  config: AppConfig,
  user: { id: string; email: string },
): void {
  const cookie = signSession(config.sessionSecret, { uid: user.id, email: user.email }, SESSION_TTL_SECONDS);
  void reply.setCookie(SESSION_COOKIE, cookie, {
    path: '/',
    httpOnly: true,
    secure: isSecure(request),
    // Lax is what lets the Google OAuth redirect land with the cookie attached
    // while still blocking cross-site POSTs from carrying it.
    sameSite: 'lax',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSession(reply: FastifyReply, request: FastifyRequest): void {
  const options = { path: '/', httpOnly: true, secure: isSecure(request), sameSite: 'lax' as const };
  void reply.clearCookie(SESSION_COOKIE, options);
  void reply.clearCookie(CSRF_COOKIE, { path: '/', secure: isSecure(request), sameSite: 'lax' });
}

export function readSession(request: FastifyRequest, config: AppConfig): SessionPayload | null {
  return verifySession(config.sessionSecret, request.cookies[SESSION_COOKIE]);
}

export function requireUser(request: FastifyRequest, config: AppConfig): SessionPayload {
  const session = readSession(request, config);
  if (session === null) {
    throw new HttpError(401, 'You must sign in with Google first', 'UNAUTHENTICATED');
  }
  return session;
}

export function requireAdmin(request: FastifyRequest, config: AppConfig): SessionPayload {
  const session = requireUser(request, config);
  if (!isAdminEmail(session.email, config)) {
    throw new HttpError(403, 'This account is not an administrator', 'FORBIDDEN');
  }
  return session;
}

export function isAdminEmail(email: string, config: AppConfig): boolean {
  const normalized = email.trim().toLowerCase();
  return config.adminEmails.some((allowed) => allowed.toLowerCase() === normalized);
}

/**
 * Sets the double-submit CSRF cookie. It is deliberately readable by scripts —
 * the protection comes from a cross-origin attacker being unable to *read* it,
 * so they cannot echo it back in the required header.
 */
export function ensureCsrfCookie(request: FastifyRequest, reply: FastifyReply): string {
  const existing = request.cookies[CSRF_COOKIE];
  if (existing !== undefined && existing.length === 64) return existing;
  const token = randomHex(32);
  void reply.setCookie(CSRF_COOKIE, token, {
    path: '/',
    httpOnly: false,
    secure: isSecure(request),
    sameSite: 'lax',
    maxAge: SESSION_TTL_SECONDS,
  });
  return token;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function verifyCsrf(request: FastifyRequest): void {
  if (!MUTATING.has(request.method)) return;
  const cookieToken = request.cookies[CSRF_COOKIE];
  const headerToken = request.headers['x-csrf-token'];
  const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;

  if (cookieToken === undefined || provided === undefined || provided.length === 0) {
    throw new HttpError(403, 'Missing CSRF token', 'CSRF_MISSING');
  }
  if (!constantTimeEqual(cookieToken, provided)) {
    throw new HttpError(403, 'Invalid CSRF token', 'CSRF_INVALID');
  }
}

export function setOAuthState(reply: FastifyReply, request: FastifyRequest): string {
  const state = randomHex(24);
  void reply.setCookie(OAUTH_STATE_COOKIE, state, {
    path: '/auth',
    httpOnly: true,
    secure: isSecure(request),
    sameSite: 'lax',
    maxAge: 600,
  });
  return state;
}

export function consumeOAuthState(request: FastifyRequest, reply: FastifyReply, state: string | null): boolean {
  const expected = request.cookies[OAUTH_STATE_COOKIE];
  void reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth' });
  if (expected === undefined || state === null || expected.length !== state.length) return false;
  return expected === state;
}
