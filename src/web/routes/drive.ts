import type { FastifyInstance } from 'fastify';
import { HttpError } from '../../lib/errors.js';
import { DriveClient } from '../../lib/drive.js';
import type { AppContext } from '../context.js';
import { requireUser } from '../auth.js';

export async function registerDriveRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { config, prisma, vault } = ctx;

  async function clientFor(userId: string): Promise<DriveClient> {
    const account = await prisma.googleAccount.findUnique({ where: { userId } });
    if (account === null) {
      throw new HttpError(409, 'Google Drive is not connected', 'NOT_CONNECTED');
    }
    let refreshToken: string;
    try {
      refreshToken = vault.openRefreshToken(account);
    } catch {
      throw new HttpError(409, 'Stored credentials could not be decrypted — reconnect Drive', 'DECRYPT_FAILED');
    }
    return new DriveClient(
      config.googleClientId,
      config.googleClientSecret,
      config.googleRedirectUri,
      refreshToken,
    );
  }

  /** Folder picker data. `drive.file` only exposes folders the app can write to. */
  app.get('/api/drive/folders', async (request) => {
    const session = requireUser(request, config);
    const drive = await clientFor(session.uid);
    const folders = await drive.listFolders();
    return {
      folders,
      defaultFolderId: config.driveRootFolderId ?? null,
    };
  });
}
