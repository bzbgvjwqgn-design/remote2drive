import pino, { type Logger } from 'pino';

let root: Logger | null = null;

function buildRoot(): Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  const isDev = (process.env.NODE_ENV ?? 'production') === 'development';
  if (isDev) {
    try {
      return pino({
        level,
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
      });
    } catch {
      // pino-pretty is a dev dependency; fall through to plain JSON.
    }
  }
  return pino({
    level,
    base: { service: 'remote-to-drive', node: process.env.NODE_ID ?? undefined },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.refreshToken',
        '*.accessToken',
        '*.sessionUri',
      ],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export function logger(): Logger {
  if (root === null) root = buildRoot();
  return root;
}

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger().child(bindings);
}
