import { PrismaClient } from '@prisma/client';

let client: PrismaClient | null = null;

export function db(): PrismaClient {
  if (client === null) {
    client = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client !== null) {
    await client.$disconnect();
    client = null;
  }
}

/** BigInt does not survive JSON.stringify, and the UI only ever needs a number. */
export function toNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}
