import { pino, type Logger } from 'pino';

/**
 * Server logger. Redacts credentials in request logs; application code must still never log
 * secrets, phone numbers, Lightning addresses or names (see lib/log.ts).
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.phone',
        '*.lnAddress',
        '*.lightningAddress',
        '*.secret',
        '*.password',
      ],
      censor: '[redacted]',
    },
  });
}
