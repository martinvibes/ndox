import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, type AdminSession } from '../lib/api';

interface Session {
  session: AdminSession;
  /** State-changing admin call with the CSRF token; a 401 signs the council out. */
  send: <T>(method: 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown) => Promise<T>;
  onUnauthorized: () => void;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({
  session,
  onUnauthorized,
  children,
}: {
  session: AdminSession;
  onUnauthorized: () => void;
  children: ReactNode;
}) {
  const send = useCallback(
    async <T,>(method: 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown) => {
      try {
        return await api.send<T>(method, path, body, session.csrfToken);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.code === 'csrf')) onUnauthorized();
        throw e;
      }
    },
    [session.csrfToken, onUnauthorized],
  );
  const value = useMemo(() => ({ session, send, onUnauthorized }), [session, send, onUnauthorized]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
