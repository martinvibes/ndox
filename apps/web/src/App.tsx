import { lazy, Suspense, useEffect } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { PublicLayout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { Skeleton } from './components/ui';
import { I18nProvider, useI18n } from './i18n';
import Home from './pages/Home';

// Everything but the home page is split out: the first load stays well under the JS budget.
const VerifyList = lazy(() => import('./pages/VerifyList'));
const VerifyEvent = lazy(() => import('./pages/VerifyEvent'));
const Sponsor = lazy(() => import('./pages/Sponsor'));
const SponsorReceipt = lazy(() => import('./pages/SponsorReceipt'));
const Data = lazy(() => import('./pages/Data'));
const Council = lazy(() => import('./council/Council'));

function Fallback() {
  return (
    <div className="grid gap-4" aria-busy="true">
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-40" />
    </div>
  );
}

function NotFound() {
  const { t } = useI18n();
  return (
    <div className="py-10">
      <p className="text-lg font-semibold text-ink">{t.common.notFound}</p>
      <Link href="/" className="mt-3 inline-flex min-h-11 items-center text-ocean hover:underline">
        {t.common.home}
      </Link>
    </div>
  );
}

function ScrollToTop() {
  const [loc] = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc]);
  return null;
}

function Routes() {
  const [loc] = useLocation();
  if (loc === '/conseil' || loc.startsWith('/conseil/')) {
    return (
      <Suspense fallback={null}>
        <Council />
      </Suspense>
    );
  }
  return (
    <PublicLayout>
      <Suspense fallback={<Fallback />}>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/verifier" component={VerifyList} />
          <Route path="/verifier/:eventId">
            {(p: { eventId: string }) => <VerifyEvent eventId={decodeURIComponent(p.eventId)} />}
          </Route>
          <Route path="/soutenir" component={Sponsor} />
          <Route path="/soutenir/:hash">
            {(p: { hash: string }) => <SponsorReceipt paymentHash={p.hash} />}
          </Route>
          <Route path="/donnees" component={Data} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </PublicLayout>
  );
}

export function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <ScrollToTop />
        <Routes />
      </ToastProvider>
    </I18nProvider>
  );
}
