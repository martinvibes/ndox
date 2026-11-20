import { HandCoins, ShieldCheck } from 'lucide-react';
import { StatusCard } from '../components/StatusCard';
import { ErrorState, ICON, LinkButton, MoneyBadge, Skeleton, StatTile } from '../components/ui';
import { useI18n } from '../i18n';
import type { Meta, Pool, Today } from '../lib/api';
import { fmtDate, fmtFcfa, fmtPct, fmtTime, satToFcfaDisplay } from '../lib/format';
import { useApi } from '../lib/useApi';

const DEFAULT_SCHEDULE = { announce: '20:00', fetch: '05:00', attest: '05:15' };
const gmt = (hhmm: string) => `${hhmm}\u00a0GMT`;

export default function Home() {
  const { t, lang } = useI18n();
  const today = useApi<Today>('/api/today', 60_000);
  const pool = useApi<Pool>('/api/pool', 60_000);
  const meta = useApi<Meta>('/api/meta');
  const schedule = meta.data?.schedule ?? DEFAULT_SCHEDULE;

  const sites = today.data?.sites ?? [];
  const attested = sites.filter((s) => s.attestation);
  const danger = attested.filter((s) => s.attestation?.outcome === 'danger');
  const summary = !today.data
    ? null
    : danger.length > 0
      ? t.home.summaryDanger(danger.map((s) => s.name).join(', '))
      : attested.length > 0
        ? t.home.summaryCalm
        : t.home.summaryPending(gmt(schedule.attest));

  return (
    <>
      <section aria-labelledby="hero">
        <h1
          id="hero"
          className="max-w-[18ch] text-title font-semibold tracking-tight text-ink sm:text-display"
        >
          {t.common.tagline}
        </h1>
        <h2 className="mt-4 text-base font-normal text-muted">
          {today.data ? t.home.seaToday(fmtDate(today.data.date, lang, 'long')) : ' '}
        </h2>
        <p
          aria-live="polite"
          className={`mt-1 text-lg font-medium ${danger.length ? 'text-danger' : 'text-ink'}`}
        >
          {summary ?? ' '}
        </p>
      </section>

      <section aria-label={t.nav.today} className="mt-8">
        {today.error && !today.data && <ErrorState error={today.error} onRetry={today.reload} />}
        <div className="grid gap-4 sm:grid-cols-2">
          {today.data
            ? sites.map((s) => <StatusCard key={s.id} site={s} attestTime={gmt(schedule.attest)} />)
            : !today.error && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[232px]" />)}
        </div>
      </section>

      <PoolSection pool={pool.data} />

      <section aria-labelledby="how" className="mt-14">
        <h2 id="how" className="text-lg font-semibold text-ink">
          {t.home.howTitle}
        </h2>
        <ol className="mt-5 grid gap-6">
          {t.home.how.map((step, i) => {
            const arg =
              i === 0
                ? gmt(schedule.announce)
                : i === 1
                  ? gmt(schedule.fetch)
                  : fmtFcfa(pool.data?.payoutFcfa ?? 2000, lang);
            return (
              <li key={step.title} className="grid grid-cols-[2.5rem_1fr] gap-x-3">
                <span
                  className="tabular row-span-2 flex h-10 w-10 items-center justify-center rounded-full border-2 border-ocean text-lg font-semibold text-ocean"
                  aria-hidden
                >
                  {i + 1}
                </span>
                <h3 className="font-semibold text-ink">{step.title}</h3>
                <p className="mt-1 max-w-[60ch] text-muted">{step.body(arg)}</p>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <LinkButton href="/soutenir">
          <HandCoins {...ICON} />
          {t.home.ctaSponsor}
        </LinkButton>
        <LinkButton href="/verifier" variant="secondary">
          <ShieldCheck {...ICON} />
          {t.home.ctaVerify}
        </LinkButton>
      </div>
    </>
  );
}

function PoolSection({ pool }: { pool: Pool | undefined }) {
  const { t, lang } = useI18n();
  if (!pool) return <Skeleton className="mt-12 h-[150px]" />;
  const price = pool.price?.xofPerBtc;
  const seasonFcfa = price ? satToFcfaDisplay(pool.payouts.seasonSat, price) : null;
  const ratio = pool.coverage.ratio;
  return (
    <section aria-labelledby="pool" className="mt-12">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 id="pool" className="text-lg font-semibold text-ink">
          {t.home.poolTitle}
        </h2>
        <MoneyBadge simulated={pool.wallet.simulated} testFunds={pool.wallet.testFunds} />
      </div>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-4">
        <StatTile
          label={t.home.balance}
          value={pool.balanceFcfa === null ? '—' : fmtFcfa(pool.balanceFcfa, lang)}
          sub={pool.balanceFcfa === null ? t.home.walletDown : undefined}
          tone={pool.balanceFcfa === null ? 'warn' : 'ink'}
        />
        <StatTile
          label={t.home.covered}
          value={pool.policies.covered}
          sub={pool.policies.waiting ? t.home.waiting(pool.policies.waiting) : undefined}
        />
        <StatTile
          label={t.home.paidSeason}
          value={seasonFcfa === null ? '—' : fmtFcfa(seasonFcfa, lang)}
          sub={t.home.paidCount(pool.payouts.seasonCount)}
        />
        <StatTile
          label={t.home.coverage}
          value={ratio === null ? '—' : fmtPct(ratio, lang)}
          sub={ratio === null ? t.home.noExposure : t.home.coverageHint}
          tone={ratio !== null && ratio < 1 ? 'warn' : 'ink'}
        />
      </dl>
      {pool.price?.stale && (
        <p className="mt-2 text-sm text-muted">
          {t.council.overview.priceStale} ({fmtTime(pool.price.asOf)})
        </p>
      )}
    </section>
  );
}
