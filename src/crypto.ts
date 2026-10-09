import crypto from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

export interface Sealed {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * AES-256-GCM sealing for the two secrets this service holds on a user's
 * behalf: the Google refresh token and the Drive resumable-session URI (which
 * is itself a bearer credential for the in-flight upload).
 */
export class Sealer {
  private readonly key: Buffer;
  readonly keyVersion: number;

  constructor(key: Buffer, keyVersion = 1) {
    if (key.length !== 32) {
      throw new CryptoError(`AES-256-GCM requires a 32-byte key, got ${key.length}`);
    }
    this.key = key;
    this.keyVersion = keyVersion;
  }

  private aad(): Buffer {
    return Buffer.from(`remote-to-drive:v${this.keyVersion}`, 'utf8');
  }

  seal(plaintext: string): Sealed {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(this.aad());
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.keyVersion,
    };
  }

  open(sealed: Sealed): string {
    if (sealed.keyVersion !== this.keyVersion) {
      throw new CryptoError(
        `sealed with key version ${sealed.keyVersion}, this node holds version ${this.keyVersion}`,
      );
    }
    let decipher: crypto.DecipherGCM;
    try {
      decipher = crypto.createDecipheriv(ALGORITHM, this.key, Buffer.from(sealed.iv, 'base64'), {
        authTagLength: TAG_BYTES,
      });
    } catch (cause) {
      throw new CryptoError(`unable to initialise decipher: ${(cause as Error).message}`);
    }
    decipher.setAAD(this.aad());
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    try {
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      // GCM final() throws on any tampering or on a wrong key.
      throw new CryptoError('authentication tag mismatch — ciphertext was tampered with or the key is wrong');
    }
  }
}

export interface SessionPayload {
  uid: string;
  email: string;
  iat: number;
  exp: number;
}

const b64u = (buf: Buffer): string => buf.toString('base64url');

function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

/**
 * Signed (not encrypted) session cookie. Signing rather than server-side
 * storage is what keeps web nodes stateless and interchangeable behind a
 * load balancer.
 */
export function signSession(
  secret: string,
  payload: Omit<SessionPayload, 'iat' | 'exp'>,
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const body: SessionPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const encoded = b64u(Buffer.from(JSON.stringify(body), 'utf8'));
  return `${encoded}.${b64u(hmac(secret, encoded))}`;
}

export function verifySession(secret: string, cookie: string | undefined): SessionPayload | null {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);

  const expected = hmac(secret, encoded);
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

export function randomHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
