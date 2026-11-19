import { getSite } from '@ndox/shared';
import { DataTable } from '../components/DataTable';
import { OutcomeBadge } from '../components/OutcomeBadge';
import { SeasonBars } from '../components/SeasonBars';
import { ErrorState, PageTitle, SectionTitle, Skeleton } from '../components/ui';
import { useI18n } from '../i18n';
import type { Backtest } from '../lib/api';
import { fmtDate, fmtFcfa, fmtInt, fmtM, fmtPct } from '../lib/format';
import { useApi } from '../lib/useApi';

const siteName = (id: string) => getSite(id)?.name ?? id;

export default function Data() {
  const { t, lang } = useI18n();
  const bt = useApi<Backtest>('/api/backtest');

  if (bt.error && !bt.data)
    return (
      <>
        <PageTitle lead={t.data.intro}>{t.data.title}</PageTitle>
        <ErrorState error={bt.error} onRetry={bt.reload} />
      </>
    );
  if (!bt.data)
    return (
      <>
        <PageTitle lead={t.data.intro}>{t.data.title}</PageTitle>
        <Skeleton className="h-96" />
      </>
    );

  const d = bt.data;
  const max = Math.max(...d.sites.flatMap((s) => s.seasons.map((x) => x.dangerDays)));
  const yMax = Math.ceil(max / 10) * 10;
  const threshold = fmtM(d.sites[0]?.thresholdM ?? 2.5, lang);
  const rate = (r: { matched: number; total: number; rate: number | null }) =>
    r.rate === null ? '—' : fmtPct(r.rate, lang);

  return (
    <>
      <PageTitle lead={t.data.intro}>{t.data.title}</PageTitle>

      <section aria-labelledby="chart">
        <SectionTitle>
          <span id="chart">{t.data.chartTitle(d.params.years[0], d.params.years[1])}</span>
        </SectionTitle>
        <p className="mb-5 max-w-[62ch] text-sm text-muted">{t.data.chartCaption(threshold)}</p>
        <div className="grid gap-6">
          {d.sites.map((s) => (
            <figure key={s.site} className="m-0">
              <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-medium text-ink">{s.name}</span>
                <span className="tabular flex gap-4 text-sm text-muted">
                  <span>
                    {t.data.mean} {fmtInt(Math.round(s.summary.mean), lang)}
                  </span>
                  <span>
                    {t.data.worst} {fmtInt(s.summary.worst, lang)}
                  </span>
                </span>
              </figcaption>
              <SeasonBars
                data={s.seasons.map((x) => ({ season: x.season, value: x.dangerDays }))}
                max={yMax}
                mean={s.summary.mean}
                label={`${s.name}. ${t.data.mean} ${s.summary.mean.toFixed(1)}, ${t.data.worst} ${s.summary.worst}.`}
              />
              <details className="mt-1 text-sm">
                <summary className="cursor-pointer text-ocean">{t.data.dangerDays}</summary>
                <table className="mt-2 w-full max-w-xs text-sm">
                  <thead>
                    <tr className="text-muted">
                      <th scope="col" className="text-left font-medium">
                        {t.data.season}
                      </th>
                      <th scope="col" className="text-right font-medium">
                        {t.data.dangerDays}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.seasons.map((x) => (
                      <tr key={x.season}>
                        <td>{x.season}</td>
                        <td className="tabular text-right">{x.dangerDays}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </figure>
          ))}
        </div>
      </section>

      <section aria-labelledby="premium" className="mt-12">
        <SectionTitle>
          <span id="premium">{t.data.premiumTitle}</span>
        </SectionTitle>
        <p className="mb-4 max-w-[62ch] text-ink">
          {t.data.premiumBody(fmtFcfa(d.params.payoutFcfa, lang), fmtPct(d.params.loading, lang))}
        </p>
        <DataTable
          caption={t.data.premiumTitle}
          rows={d.sites}
          rowKey={(s) => s.site}
          columns={[
            { key: 'site', header: t.verify.site, cell: (s) => s.name },
            {
              key: 'premium',
              header: t.data.premiumWeekly,
              align: 'right',
              cell: (s) => fmtFcfa(s.premiumWeeklyFcfa, lang),
            },
            {
              key: 'reserve',
              header: t.data.reserve,
              align: 'right',
              wide: true,
              cell: (s) => fmtFcfa(s.reservePerPolicyFcfa, lang),
            },
          ]}
        />
      </section>

      <section aria-labelledby="alerts" className="mt-12">
        <SectionTitle>
          <span id="alerts">{t.data.alertsTitle}</span>
        </SectionTitle>
        <p className="max-w-[62ch] text-muted">{t.data.alertsBody}</p>
        <ul className="my-4 grid gap-1 text-ink">
          <li className="tabular">
            {t.data.era5Rate(d.alertCheck.era5.matched, d.alertCheck.era5.total)} (
            {rate(d.alertCheck.era5)})
          </li>
          <li className="tabular">
            {t.data.liveRate(d.alertCheck.live.matched, d.alertCheck.live.total)} (
            {rate(d.alertCheck.live)})
          </li>
        </ul>
        <DataTable
          caption={t.data.alertsTitle}
          rows={d.alertCheck.rows}
          rowKey={(r) => `${r.date}:${r.site}`}
          columns={[
            {
              key: 'date',
              header: t.data.alertDate,
              cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.date, lang)}</span>,
            },
            { key: 'site', header: t.verify.site, cell: (r) => siteName(r.site) },
            {
              key: 'era5',
              header: t.data.era5,
              align: 'right',
              wide: true,
              cell: (r) => fmtM(r.era5MaxM, lang),
            },
            {
              key: 'fired',
              header: t.data.fired,
              cell: (r) => (r.era5Fired === null ? '—' : r.era5Fired ? t.data.yes : t.data.no),
            },
            {
              key: 'live',
              header: t.data.liveOutcome,
              cell: (r) => <OutcomeBadge outcome={r.liveOutcome} />,
            },
          ]}
        />
        <p className="mt-2 text-sm text-muted">{t.data.alertNote}</p>
      </section>

      {d.calibration?.length > 0 && (
        <section aria-labelledby="calibration" className="mt-12">
          <SectionTitle>
            <span id="calibration">{t.data.calibrationTitle}</span>
          </SectionTitle>
          <p className="mb-4 max-w-[62ch] text-muted">{t.data.calibrationBody}</p>
          <DataTable
            caption={t.data.calibrationTitle}
            rows={d.calibration}
            rowKey={(c) => String(c.thresholdM)}
            columns={[
              {
                key: 'm',
                header: t.data.calThreshold,
                cell: (c) => <span className="tabular">{fmtM(c.thresholdM, lang)}</span>,
              },
              {
                key: 'era5',
                header: t.data.calEra5,
                align: 'right',
                cell: (c) => rate(c.alertMatchEra5),
              },
              {
                key: 'live',
                header: t.data.calLive,
                align: 'right',
                cell: (c) => rate(c.alertMatchLive),
              },
              {
                key: 'kayar',
                header: t.data.calPremium('Kayar'),
                align: 'right',
                wide: true,
                cell: (c) => {
                  const k = c.sites.find((s) => s.site === 'kayar');
                  return k ? fmtFcfa(k.premiumWeeklyFcfa, lang) : '—';
                },
              },
            ]}
          />
        </section>
      )}

      <section aria-labelledby="sources" className="mt-12">
        <SectionTitle>
          <span id="sources">{t.data.sourcesTitle}</span>
        </SectionTitle>
        <ul className="grid list-disc gap-1 pl-5 text-ink">
          {t.data.sources.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p className="mt-4 rounded-card border border-warn/30 bg-warn-bg px-4 py-3 text-sm text-warn">
          <strong className="font-semibold">{t.data.caveat}</strong> {t.data.caveatText}
        </p>
      </section>
    </>
  );
}
