import { Gauge, History, LogOut, Settings2, Users } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { LangToggle, Wordmark } from '../components/Layout';
import { useToast } from '../components/Toast';
import { Badge, Button, Skeleton } from '../components/ui';
import { useI18n } from '../i18n';
import { api, ApiError, type AdminSession } from '../lib/api';
import { SessionProvider } from './session';

const Overview = lazy(() => import('./Overview'));
const Crews = lazy(() => import('./Crews'));
const Replay = lazy(() => import('./Replay'));
const Settings = lazy(() => import('./Settings'));

type State = { kind: 'loading' } | { kind: 'out' } | { kind: 'in'; session: AdminSession };

export default function Council() {
  const { t } = useI18n();
  const toast = useToast();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    api
      .get<AdminSession>('/api/admin/session')
      .then((session) => setState({ kind: 'in', session }))
      .catch(() => setState({ kind: 'out' }));
  }, []);

  const signedOut = useCallback(() => {
    setState({ kind: 'out' });
    toast(t.council.sessionExpired, 'error');
  }, [toast, t]);

  async function logout() {
    if (state.kind !== 'in') return;
    await api.send('POST', '/api/admin/logout', undefined, state.session.csrfToken).catch(() => {});
    setState({ kind: 'out' });
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <Link href="/" className="-ml-1 rounded-btn p-1" aria-label="Ndox">
            <Wordmark />
          </Link>
          <span className="text-muted">{t.council.title}</span>
          {state.kind === 'in' && state.session.wallet?.simulated && <Badge kind="simulated" />}
          <div className="ml-auto flex items-center gap-2 sm:order-last">
            <LangToggle />
            {state.kind === 'in' && (
              <Button
                variant="ghost"
                onClick={() => void logout()}
                className="min-h-9 px-2 text-sm"
                aria-label={t.council.logout}
              >
                <LogOut size={18} strokeWidth={1.75} aria-hidden />
                <span className="hidden sm:inline">{t.council.logout}</span>
              </Button>
            )}
          </div>
          {state.kind === 'in' && <CouncilNav />}
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-8">
        {state.kind === 'loading' ? (
          <Skeleton className="h-64" />
        ) : state.kind === 'out' ? (
          <Login onIn={(session) => setState({ kind: 'in', session })} />
        ) : (
          <SessionProvider session={state.session} onUnauthorized={signedOut}>
            <Suspense fallback={<Skeleton className="h-64" />}>
              <Switch>
                <Route path="/conseil" component={Overview} />
                <Route path="/conseil/equipages" component={Crews} />
                <Route path="/conseil/rejeu" component={Replay} />
                <Route path="/conseil/parametres" component={Settings} />
                <Route>
                  <p className="text-ink">{t.common.notFound}</p>
                </Route>
              </Switch>
            </Suspense>
          </SessionProvider>
        )}
      </main>
    </div>
  );
}

function CouncilNav() {
  const { t } = useI18n();
  const [loc] = useLocation();
  const I = { size: 18, strokeWidth: 1.75, 'aria-hidden': true } as const;
  const items: [string, string, ReactNode][] = [
    ['/conseil', t.council.nav.overview, <Gauge key="o" {...I} />],
    ['/conseil/equipages', t.council.nav.crews, <Users key="c" {...I} />],
    ['/conseil/rejeu', t.council.nav.replay, <History key="r" {...I} />],
    ['/conseil/parametres', t.council.nav.settings, <Settings2 key="s" {...I} />],
  ];
  return (
    <nav
      aria-label={t.council.title}
      className="-mx-1 flex w-full gap-1 overflow-x-auto sm:mx-0 sm:w-auto sm:flex-1"
    >
      {items.map(([href, label, icon]) => (
        <Link
          key={href}
          href={href}
          aria-current={loc === href ? 'page' : undefined}
          className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-btn px-3 text-sm font-medium ${
            loc === href ? 'bg-ocean-50 text-ocean' : 'text-muted hover:text-ink'
          }`}
        >
          {icon}
          {label}
        </Link>
      ))}
    </nav>
  );
}

function Login({ onIn }: { onIn: (s: AdminSession) => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.send('POST', '/api/admin/login', { password });
      onIn(await api.get<AdminSession>('/api/admin/session'));
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'rate_limited'
          ? t.council.tooMany
          : t.council.badPassword,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm py-8">
      <h1 className="text-title font-semibold tracking-tight text-ink">{t.council.loginTitle}</h1>
      <p className="mt-2 text-muted">{t.council.loginBody}</p>
      <form
        className="mt-6 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (password && !busy) void submit();
        }}
      >
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {t.council.password}
        </label>
        <input
          id={id}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          className="min-h-11 rounded-btn border border-line bg-surface px-3"
        />
        {error && (
          <p id={`${id}-err`} role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!password || busy}>
          {t.council.login}
        </Button>
      </form>
    </div>
  );
}
