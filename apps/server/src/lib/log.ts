/**
 * Minimal structured logger interface shared by jobs, the CLI and the HTTP server (pino adapter).
 * Never pass secrets, phone numbers, Lightning addresses or names in `data`.
 */
export interface Log {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

interface PinoLike {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export function fromPino(p: PinoLike): Log {
  return {
    info: (msg, data) => p.info(data ?? {}, msg),
    warn: (msg, data) => p.warn(data ?? {}, msg),
    error: (msg, data) => p.error(data ?? {}, msg),
  };
}

export const consoleLog: Log = {
  info: (msg, data) => console.log(msg, data ? JSON.stringify(data) : ''),
  warn: (msg, data) => console.warn(msg, data ? JSON.stringify(data) : ''),
  error: (msg, data) => console.error(msg, data ? JSON.stringify(data) : ''),
};

export const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
