import type { FastifyInstance } from 'fastify';
import { google } from 'googleapis';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import type { AppContext } from '../context.js';
import {
  clearSession,
  consumeOAuthState,
  ensureCsrfCookie,
  isAdminEmail,
  issueSession,
  readSession,
  requireUser,
  setOAuthState,
  verifyCsrf,
} from '../auth.js';

/**
 * `drive.file` only. The user grants access to files this app creates, never
 * to their whole Drive — which is also what keeps the OAuth review surface
 * small. `prompt=consent` forces Google to hand back a refresh token on every
 * authorization rather than only the first.
 */
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
];

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config, prisma, vault } = ctx;

  const oauthClient = () =>
    new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);

  app.get('/auth/google', async (request, reply) => {
    const state = setOAuthState(reply, request);
    const url = oauthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: SCOPES,
      state,
    });
    return reply.redirect(url);
  });

  const callbackQuery = z.object({
    code: z.string().min(1).optional(),
    state: z.string().optional().nullable(),
    error: z.string().optional(),
  });

  app.get('/auth/google/callback', async (request, reply) => {
    const parsed = callbackQuery.safeParse(request.query);
    if (!parsed.success) throw new HttpError(400, 'Malformed OAuth callback', 'BAD_REQUEST');
    const { code, state, error } = parsed.data;

    if (error !== undefined) {
      // "access_denied" is the user pressing Cancel — not an error worth alarming them with.
      const reason = error === 'access_denied' ? 'cancelled' : 'oauth_failed';
      return reply.redirect(`/?auth=${reason}`);
    }
    if (code === undefined) throw new HttpError(400, 'Missing authorization code', 'BAD_REQUEST');
    if (!consumeOAuthState(request, reply, state ?? null)) {
      throw new HttpError(400, 'OAuth state mismatch — restart the sign-in', 'CSRF_INVALID');
    }

    let tokens;
    try {
      ({ tokens } = await oauthClient().getToken(code));
    } catch (cause) {
      request.log.error({ err: (cause as Error).message }, 'token exchange failed');
      return reply.redirect('/?auth=token_exchange_failed');
    }
    if (tokens.refresh_token === undefined && tokens.access_token === undefined) {
      return reply.redirect('/?auth=no_token');
    }

    const oauth = google.oauth2({ version: 'v2', auth: oauthClientWithTokens(tokens) });
    let profile: { email?: string | null; name?: string | null; picture?: string | null };
    try {
      const response = await oauth.userinfo.get();
      profile = response.data ?? {};
    } catch {
      profile = {};
    }

    // The email is the only stable identity we can hang tokens on, and the
    // `email` scope is what makes userinfo return it.
    const email = (profile.email ?? '').toLowerCase().trim();
    if (email === '') {
      request.log.error('Google returned no email for the authorized account');
      return reply.redirect('/?auth=no_email');
    }

    const sealed =
      typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0
        ? vault.sealSecret(tokens.refresh_token)
        : null;

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: profile.name ?? null,
        avatarUrl: profile.picture ?? null,
        lastLogin: new Date(),
      },
      update: {
        name: profile.name ?? null,
        avatarUrl: profile.picture ?? null,
        lastLogin: new Date(),
      },
    });

    const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

    if (sealed !== null) {
      await prisma.googleAccount.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          scope: SCOPES.join(' '),
          tokenCiphertext: sealed.ciphertext,
          tokenIv: sealed.iv,
          tokenTag: sealed.tag,
          tokenKeyVersion: sealed.keyVersion,
          expiresAt,
        },
        update: {
          scope: SCOPES.join(' '),
          tokenCiphertext: sealed.ciphertext,
          tokenIv: sealed.iv,
          tokenTag: sealed.tag,
          tokenKeyVersion: sealed.keyVersion,
          expiresAt,
        },
      });
    }
    // If Google omitted refresh_token the existing stored one is still valid,
    // so the account stays connected.

    issueSession(reply, request, config, { id: user.id, email: user.email });
    ensureCsrfCookie(request, reply);
    return reply.redirect('/');
  });

  function oauthClientWithTokens(tokens: { access_token?: string | null }) {
    const client = oauthClient();
    client.setCredentials({ access_token: tokens.access_token ?? undefined });
    return client;
  }

  app.post('/auth/logout', async (request, reply) => {
    verifyCsrf(request);
    clearSession(reply, request);
    return { ok: true };
  });

  app.get('/api/csrf', async (request, reply) => {
    return { token: ensureCsrfCookie(request, reply) };
  });

  app.get('/api/me', async (request, reply) => {
    const csrfToken = ensureCsrfCookie(request, reply);
    const session = readSession(request, config);
    if (session === null) return { authenticated: false, csrfToken };

    const user = await prisma.user.findUnique({
      where: { id: session.uid },
      include: { google: { select: { scope: true, updatedAt: true } } },
    });
    if (user === null) return { authenticated: false, csrfToken };

    return {
      authenticated: true,
      csrfToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        isAdmin: isAdminEmail(user.email, config),
        driveConnected: user.google !== null,
        driveScope: user.google?.scope ?? null,
      },
      limits: {
        maxActiveJobsPerUser: config.maxActiveJobsPerUser,
        maxUrlsPerRequest: config.maxUrlsPerRequest,
        maxFileSizeBytes: config.maxFileSizeBytes,
        chunkSizeBytes: config.chunkSizeBytes,
      },
    };
  });
}

export { requireUser };
