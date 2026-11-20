import { SITES } from '@ndox/shared';
import { AlertTriangle, CircleAlert, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '../components/DataTable';
import { useToast } from '../components/Toast';
import {
  Badge,
  Button,
  ErrorState,
  ICON,
  MoneyBadge,
  SectionTitle,
  Skeleton,
  StatTile,
} from '../components/ui';
import { useI18n } from '../i18n';
import type { Messages } from '../i18n/fr';
import { ApiError } from '../lib/api';
import type { AdminAlert, AdminPayout, Outlook, Pool } from '../lib/api';
import {
  fmtDate,
  fmtDateTime,
  fmtFcfa,
  fmtM,
  fmtPct,
  fmtSat,
  satToFcfaDisplay,
} from '../lib/format';
import { useApi } from '../lib/useApi';
import { useSession } from './session';

export default function Overview() {
  const { t } = useI18n();
  return (
    <div className="grid gap-12">
      <h1 className="sr-only">{t.council.nav.overview}</h1>
      <PoolHealth />
      <Alerts />
      <ForecastStrip />
      <RecentPayouts />
    </div>
  );
}

function PoolHealth() {
  const { t, lang } = useI18n();
  const pool = useApi<Pool>('/api/pool', 30_000);
  if (pool.error && !pool.data) return <ErrorState error={pool.error} onRetry={pool.reload} />;
  const p = pool.data;
  if (!p) return <Skeleton className="h-28" />;
  const fcfa = (sat: number | null) =>
    sat === null || !p.price ? '—' : fmtFcfa(satToFcfaDisplay(sat, p.price.xofPerBtc), lang);
  const ratio = p.coverage.ratio;
  return (
    <section aria-labelledby="health">
      <SectionTitle
        aside={<MoneyBadge simulated={p.wallet.simulated} testFunds={p.wallet.testFunds} />}
      >
        <span id="health">{t.council.overview.health}</span>
      </SectionTitle>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line lg:grid-cols-4">
        <StatTile
          label={t.home.balance}
          value={p.balanceSat === null ? t.home.walletDown : fcfa(p.balanceSat)}
          sub={p.balanceSat === null ? undefined : fmtSat(p.balanceSat, lang)}
          tone={p.balanceSat === null ? 'danger' : 'ink'}
        />
        <StatTile
          label={t.council.overview.available}
          value={fcfa(p.availableSat)}
          sub={`${t.council.overview.outstanding} ${fmtSat(p.outstandingSat, lang)}`}
        />
        <StatTile
          label={t.home.coverage}
          value={ratio === null ? '—' : fmtPct(ratio, lang)}
          sub={ratio === null ? t.home.noExposure : t.home.coverageHint}
          tone={ratio !== null && ratio < 1 ? 'warn' : 'ink'}
        />
        <StatTile
          label={t.council.overview.cap}
          value={fmtSat(p.dailyCapSat, lang)}
          sub={t.council.overview.paidToday(fmtSat(p.paidTodaySat, lang))}
        />
        <StatTile
          label={t.home.covered}
          value={p.policies.covered}
          sub={t.home.waiting(p.policies.waiting)}
        />
        <StatTile
          label={t.home.paidSeason}
          value={fcfa(p.payouts.seasonSat)}
          sub={t.home.paidCount(p.payouts.seasonCount)}
        />
        <StatTile
          label={t.council.overview.price}
          value={p.price ? fmtFcfa(Math.round(p.price.xofPerBtc), lang) : '—'}
          sub={
            p.price
              ? `${t.council.overview.perBtc}, ${p.price.source}${p.price.stale ? `, ${t.council.overview.priceStale}` : ''}`
              : undefined
          }
          tone={!p.price || p.price.stale ? 'warn' : 'ink'}
        />
        <StatTile
          label={t.council.crews.state.awaiting_premium}
          value={p.policies.awaitingPremium}
          tone={p.policies.awaitingPremium > 0 ? 'warn' : 'ink'}
        />
      </dl>
    </section>
  );
}

export function alertText(t: Messages, a: AdminAlert): string {
  const m = t.council.alert as unknown as Record<string, unknown>;
  const v = m[a.code];
  const base =
    typeof v === 'function'
      ? (v as (s: string) => string)(String(a.detail.crew ?? a.detail.site ?? ''))
      : typeof v === 'string'
        ? v
        : a.code;
  const times = t.council.alert.times(a.count);
  return times ? `${base} (${times})` : base;
}

function Alerts() {
  const { t, lang } = useI18n();
  const res = useApi<{ alerts: AdminAlert[] }>('/api/admin/alerts', 60_000);
  const alerts = res.data?.alerts;
  return (
    <section aria-labelledby="alerts">
      <SectionTitle>
        <span id="alerts">{t.council.overview.alerts}</span>
      </SectionTitle>
      {res.error && !alerts ? (
        <ErrorState error={res.error} onRetry={res.reload} />
      ) : !alerts ? (
        <Skeleton className="h-16" />
      ) : alerts.length === 0 ? (
        <p className="text-muted">{t.council.overview.noAlerts}</p>
      ) : (
        <ul className="grid gap-2" aria-live="polite">
          {alerts.map((a, i) => (
            <li
              key={`${a.code}:${a.at}:${i}`}
              className={`flex items-start gap-3 rounded-card border px-4 py-3 ${
                a.level === 'error'
                  ? 'border-danger/30 bg-danger-bg text-danger'
                  : 'border-warn/30 bg-warn-bg text-warn'
              }`}
            >
              {a.level === 'error' ? <CircleAlert {...ICON} /> : <AlertTriangle {...ICON} />}
              <span className="flex-1 text-ink">{alertText(t, a)}</span>
              <time dateTime={a.at} className="tabular shrink-0 text-sm text-muted">
                {fmtDateTime(a.at, lang)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const CELL = {
  danger: 'bg-danger-bg text-danger border-danger/30',
  calme: 'bg-calm-bg text-calm border-calm/30',
  indisponible: 'bg-bg text-muted border-line',
  pending: 'bg-bg text-muted border-line',
} as const;

function ForecastStrip() {
  const { t } = useI18n();
  return (
    <section aria-labelledby="strip">
      <SectionTitle aside={<Badge kind="forecast" />}>
        <span id="strip">{t.council.overview.strip}</span>
      </SectionTitle>
      <p className="mb-4 text-sm text-muted">{t.council.overview.stripHint}</p>
      <div className="grid gap-3">
        {SITES.map((s) => (
          <ForecastRow key={s.id} site={s.id} name={s.name} />
        ))}
      </div>
    </section>
  );
}

function ForecastRow({ site, name }: { site: string; name: string }) {
  const { t, lang } = useI18n();
  const res = useApi<Outlook>(`/api/forecast/${site}`);
  const o = res.data;
  return (
    <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:items-center">
      <span className="font-medium text-ink">{name}</span>
      {res.error && !o ? (
        <p className="text-sm text-muted">{t.council.overview.stripError}</p>
      ) : !o ? (
        <Skeleton className="h-14" />
      ) : (
        <ol
          className="grid grid-cols-7 gap-1"
          aria-label={`${name}, ${t.common.threshold(fmtM(o.thresholdM, lang))}`}
        >
          {o.days.slice(0, 7).map((d) => (
            <li
              key={d.date}
              className={`min-w-0 rounded-md border px-1 py-1.5 text-center ${CELL[d.outcome]}`}
            >
              <span className="block truncate text-xs">{fmtDate(d.date, lang, 'day')}</span>
              <span className="tabular block text-sm font-semibold">
                {d.decisiveM === null ? '—' : fmtM(d.decisiveM, lang)}
              </span>
              <span className="sr-only">{t.outcome[d.outcome]}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const PAYOUT_TONE = {
  paid: 'text-calm',
  failed: 'text-danger',
  pending: 'text-muted',
  paying: 'text-ocean',
} as const;

function RecentPayouts() {
  const { t, lang } = useI18n();
  const { send } = useSession();
  const toast = useToast();
  const res = useApi<{ items: AdminPayout[] }>('/api/admin/payouts?limit=10', 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const items = res.data?.items;

  async function retry(id: string) {
    setBusy(id);
    try {
      await send('POST', `/api/admin/payouts/${id}/retry`);
      toast(t.council.overview.retried);
      res.reload();
    } catch (e) {
      toast(
        e instanceof ApiError
          ? `${t.sponsor.errors.generic} (${e.code})`
          : t.sponsor.errors.generic,
        'error',
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="payouts">
      <SectionTitle
        aside={
          <MoneyBadge
            simulated={items?.some((p) => p.simulated)}
            testFunds={items?.some((p) => p.testFunds)}
          />
        }
      >
        <span id="payouts">{t.council.overview.payouts}</span>
      </SectionTitle>
      {res.error && !items ? (
        <ErrorState error={res.error} onRetry={res.reload} />
      ) : !items ? (
        <Skeleton className="h-40" />
      ) : items.length === 0 ? (
        <p className="text-muted">{t.council.overview.noPayouts}</p>
      ) : (
        <DataTable
          caption={t.council.overview.payouts}
          rows={items}
          rowKey={(p) => p.id}
          columns={[
            {
              key: 'when',
              header: t.council.overview.when,
              cell: (p) => (
                <span className="whitespace-nowrap">{fmtDateTime(p.createdAt, lang)}</span>
              ),
            },
            { key: 'crew', header: t.council.overview.crew, cell: (p) => p.crew },
            {
              key: 'site',
              header: t.verify.site,
              wide: true,
              cell: (p) => SITES.find((s) => s.id === p.site)?.name ?? p.site,
            },
            {
              key: 'amount',
              header: t.event.amount,
              align: 'right',
              cell: (p) => (
                <span className="whitespace-nowrap">
                  {fmtFcfa(p.amountFcfa, lang)}
                  <span className="block text-xs text-muted">{fmtSat(p.amountSat, lang)}</span>
                </span>
              ),
            },
            {
              key: 'status',
              header: t.council.overview.status,
              cell: (p) => (
                <span
                  className={`font-medium ${PAYOUT_TONE[p.status]}`}
                  title={p.error ?? undefined}
                >
                  {t.council.payoutStatus[p.status]}
                </span>
              ),
            },
            {
              key: 'action',
              header: <span className="sr-only">{t.council.crews.actions}</span>,
              cell: (p) =>
                p.status === 'failed' ? (
                  <Button
                    variant="secondary"
                    className="min-h-9 px-3 text-sm"
                    disabled={busy === p.id}
                    onClick={() => void retry(p.id)}
                  >
                    <RotateCcw size={16} strokeWidth={1.75} aria-hidden />
                    {t.council.overview.retry}
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
    </section>
  );
}
