import { Sealer, type Sealed } from '../crypto.js';
import { CryptoError } from '../crypto.js';

/** Minimal shapes so this works with Prisma rows or plain objects in tests. */
export interface SealedColumns {
  ciphertext: string | null;
  iv: string | null;
  tag: string | null;
  keyVersion?: number | null;
}

export interface GoogleAccountRow {
  tokenCiphertext: string;
  tokenIv: string;
  tokenTag: string;
  tokenKeyVersion: number;
  scope: string;
  expiresAt: Date | null;
}

export interface JobSessionColumns {
  sessionCiphertext: string | null;
  sessionIv: string | null;
  sessionTag: string | null;
}

/**
 * Single place that knows which columns hold sealed material. Both the Google
 * refresh token and the Drive resumable-session URI grant access to a user's
 * data, so neither is ever stored or logged in the clear.
 */
export class TokenVault {
  constructor(private readonly sealer: Sealer) {}

  get keyVersion(): number {
    return this.sealer.keyVersion;
  }

  sealSecret(plaintext: string): Sealed {
    return this.sealer.seal(plaintext);
  }

  openRefreshToken(account: GoogleAccountRow): string {
    return this.sealer.open({
      ciphertext: account.tokenCiphertext,
      iv: account.tokenIv,
      tag: account.tokenTag,
      keyVersion: account.tokenKeyVersion,
    });
  }

  sealSessionUri(sessionUri: string): JobSessionColumns {
    const sealed = this.sealer.seal(sessionUri);
    return {
      sessionCiphertext: sealed.ciphertext,
      sessionIv: sealed.iv,
      sessionTag: sealed.tag,
    };
  }

  /** Returns null when the job never got a session, or it cannot be opened. */
  openSessionUri(job: JobSessionColumns): string | null {
    if (!job.sessionCiphertext || !job.sessionIv || !job.sessionTag) return null;
    try {
      return this.sealer.open({
        ciphertext: job.sessionCiphertext,
        iv: job.sessionIv,
        tag: job.sessionTag,
        keyVersion: this.sealer.keyVersion,
      });
    } catch (error) {
      if (error instanceof CryptoError) return null;
      throw error;
    }
  }
}
