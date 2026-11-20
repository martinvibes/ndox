import { pino, type DestinationStream, type Logger } from 'pino';

/** Query parameters that may carry a secret (the Africa's Talking callback token). */
const SECRET_PARAMS = /([?&](?:token|key|secret|password)=)[^&#]*/gi;

export function redactUrl(url: string): string {
  return url.replace(SECRET_PARAMS, '$1[redacted]');
}

/**
 * Server logger. Redacts credentials in request logs (headers, secret query parameters);
 * application code must still never log secrets, phone numbers, Lightning addresses or names
 * (see lib/log.ts).
 */
export function createLogger(level: string, dest?: DestinationStream): Logger {
  return pino(
    {
      level,
      serializers: {
        req: (req: { method?: string; url?: string; host?: string; ip?: string }) => ({
          method: req.method,
          url: redactUrl(req.url ?? ''),
          host: req.host,
          remoteAddress: req.ip,
        }),
      },
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
    },
    dest,
  );
}
