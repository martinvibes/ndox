import { HandCoins, MessageSquareText, ShieldCheck, Smartphone } from 'lucide-react';
import { SeaLine } from '../components/SeaLine';
import { RulesExplainer } from '../components/RulesExplainer';
import { SeaBulletin } from '../components/SeaBulletin';
import { StatusCard } from '../components/StatusCard';
import { ErrorState, ICON, LinkButton, MoneyBadge, Skeleton, StatTile } from '../components/ui';
import { useI18n } from '../i18n';
import type { Meta, Pool, Today } from '../lib/api';
import { fmtDate, fmtFcfa, fmtM, fmtPct, fmtTime, satToFcfaDisplay } from '../lib/format';
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

  const payout = fmtFcfa(pool.data?.payoutFcfa ?? 2000, lang);
  const kayar = sites.find((s) => s.id === 'kayar');
  const times = [schedule.announce, schedule.fetch, schedule.attest];

  return (
    <>
      {/* Hero: what Ndox is, in one read, and what a crew actually receives. */}
      <section
        aria-labelledby="hero"
        className="grid items-center gap-10 lg:grid-cols-[1.25fr_1fr] lg:gap-14"
      >
        <div>
          <h1
            id="hero"
            className="max-w-[16ch] text-[2.5rem] leading-[1.05] font-medium tracking-tight text-ink sm:text-hero"
          >
            {t.common.tagline}
          </h1>
          <p className="mt-6 max-w-[56ch] text-lg leading-relaxed text-muted">
            {t.home.heroLead(payout)}
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <LinkButton href="/soutenir">
              <HandCoins {...ICON} />
              {t.home.ctaSponsor}
            </LinkButton>
            <LinkButton href="/verifier" variant="secondary">
              <ShieldCheck {...ICON} />
              {t.home.ctaVerify}
            </LinkButton>
          </div>
        </div>

        <figure className="m-0 rounded-[22px] border border-line bg-mist p-5 sm:p-6">
          <figcaption className="text-sm text-muted">{t.home.smsExampleLabel}</figcaption>
          <div className="mt-4 rounded-2xl rounded-bl-md bg-surface p-4 text-[0.95rem] leading-relaxed text-ink shadow-card">
            <span className="mb-1 flex items-center gap-2 text-xs font-semibold text-deep">
              <MessageSquareText size={16} strokeWidth={1.75} aria-hidden />
              NDOX
            </span>
            {t.home.smsExample}
          </div>
          <p className="mt-4 text-sm text-muted">{t.home.smsExampleNote}</p>
        </figure>
      </section>

      <dl className="mt-12 grid gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-3">
        {t.home.heroFacts.map((f) => (
          <div key={f.label} className="bg-surface px-5 py-4">
            <dt className="sr-only">{f.label}</dt>
            <dd className="tabular font-display text-title leading-none text-deep">{f.value}</dd>
            <dd className="mt-1.5 text-sm text-muted">{f.label}</dd>
          </div>
        ))}
      </dl>

      {/* The rule, drawn. */}
      <section aria-label={t.home.howTitle} className="mt-14">
        <SeaLine />
        <p className="mt-4 max-w-[70ch] text-muted">
          {t.home.seaCaption(fmtM(kayar?.thresholdM ?? 2.5, lang))}
        </p>
      </section>

      <section aria-labelledby="today" className="mt-16">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <h2 id="today" className="text-title font-medium text-ink">
            {today.data ? t.home.seaToday(fmtDate(today.data.date, lang, 'long')) : t.nav.today}
          </h2>
          <p
            aria-live="polite"
            className={`text-base font-medium ${danger.length ? 'text-danger' : 'text-muted'}`}
          >
            {summary ?? ' '}
          </p>
        </div>
        <div className="mt-6">
          {today.error && !today.data && <ErrorState error={today.error} onRetry={today.reload} />}
          <div className="grid gap-4 sm:grid-cols-2">
            {today.data
              ? sites.map((s) => (
                  <StatusCard key={s.id} site={s} attestTime={gmt(schedule.attest)} />
                ))
              : !today.error && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[232px]" />)}
          </div>
        </div>
      </section>

      <SeaBulletin />

      <section aria-labelledby="how" className="mt-16">
        <h2 id="how" className="text-title font-medium text-ink">
          {t.home.howTitle}
        </h2>
        <p className="mt-2 max-w-[60ch] text-muted">{t.home.howLead}</p>
        <ol className="mt-8 grid gap-8 sm:grid-cols-3 sm:gap-6">
          {t.home.how.map((step, i) => {
            const arg = i === 0 ? gmt(schedule.announce) : i === 1 ? gmt(schedule.fetch) : payout;
            return (
              <li key={step.title} className="border-t-2 border-deep pt-4">
                <p className="tabular text-sm font-medium text-deep">
                  {i < 2 ? gmt(times[i]!) : t.home.howTimes[2]}
                </p>
                <h3 className="mt-2 font-display text-lg font-medium text-ink">{step.title}</h3>
                <p className="mt-2 text-muted">{step.body(arg)}</p>
              </li>
            );
          })}
        </ol>
      </section>

      <PoolSection pool={pool.data} />

      <RulesExplainer />

      <section
        aria-labelledby="cta"
        className="mt-16 grid gap-6 rounded-[22px] bg-deep px-6 py-8 text-white sm:grid-cols-[1.5fr_auto] sm:items-center sm:px-10 sm:py-10"
      >
        <div>
          <h2 id="cta" className="text-title font-medium">
            {t.home.ctaBandTitle}
          </h2>
          <p className="mt-2 max-w-[56ch] text-white/75">{t.home.ctaBandBody}</p>
        </div>
        <div className="flex flex-col gap-3">
          <LinkButton href="/soutenir" className="bg-white !text-deep hover:!bg-saffron-50">
            <HandCoins {...ICON} />
            {t.home.ctaSponsor}
          </LinkButton>
          <LinkButton href="/e" native variant="ghost" className="!text-white hover:!bg-white/10">
            <Smartphone {...ICON} />
            {t.home.ctaCrew}
          </LinkButton>
        </div>
      </section>
    </>
  );
}

function PoolSection({ pool }: { pool: Pool | undefined }) {
  const { t, lang } = useI18n();
  if (!pool) return <Skeleton className="mt-16 h-[150px]" />;
  const price = pool.price?.xofPerBtc;
  const seasonFcfa = price ? satToFcfaDisplay(pool.payouts.seasonSat, price) : null;
  const ratio = pool.coverage.ratio;
  return (
    <section aria-labelledby="pool" className="mt-16">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 id="pool" className="text-title font-medium text-ink">
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
