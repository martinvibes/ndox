import { getSite } from '@ndox/shared';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'wouter';
import { Badge, ErrorState, PageTitle, Skeleton } from '../components/ui';
import { useI18n } from '../i18n';
import type { SponsorInvoice } from '../lib/api';
import { fmtDate, fmtDateTime, fmtFcfa, fmtSat } from '../lib/format';
import { useApi } from '../lib/useApi';

/** Shareable receipt for a gift: amount, beneficiary, status and the payment identifier. */
export default function SponsorReceipt({ paymentHash }: { paymentHash: string }) {
  const { t, lang } = useI18n();
  const valid = /^[0-9a-f]{64}$/.test(paymentHash);
  const r = useApi<SponsorInvoice>(valid ? `/api/sponsor/invoice/${paymentHash}` : null);

  const back = (
    <Link
      href="/soutenir"
      className="-ml-2 mb-4 inline-flex min-h-11 items-center gap-1 rounded-btn px-2 text-sm text-muted hover:text-ink"
    >
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
      {t.sponsor.title}
    </Link>
  );
  if (!valid || r.error?.status === 404) {
    return (
      <>
        {back}
        <p className="text-lg font-semibold text-ink">{t.common.notFound}</p>
      </>
    );
  }
  if (r.error && !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Skeleton className="h-64" />;
  const d = r.data;
  const who =
    d.crew ?? (d.site ? `${t.sponsor.pool} (${getSite(d.site)?.name ?? d.site})` : t.sponsor.pool);
  const rows: [string, string][] = [
    [t.sponsor.receiptAmount, `${fmtFcfa(d.amountFcfa, lang)} (${fmtSat(d.amountSat, lang)})`],
    [t.sponsor.receiptFor, who],
    [t.sponsor.receiptStatus, t.sponsor.status[d.status]],
    [t.sponsor.receiptDate, fmtDateTime(d.paidAt ?? d.createdAt, lang)],
  ];
  return (
    <>
      {back}
      <PageTitle>{t.sponsor.receiptTitle}</PageTitle>
      {d.simulated && <Badge kind="simulated" className="mb-4" />}
      <dl className="divide-y divide-line rounded-card border border-line bg-surface px-4">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap justify-between gap-2 py-3">
            <dt className="text-muted">{k}</dt>
            <dd className="tabular font-medium text-ink">{v}</dd>
          </div>
        ))}
        {d.cover && (
          <div className="py-3 text-sm text-muted">
            {t.sponsor.coverFrom(
              fmtDate(d.cover.activeFrom, lang),
              fmtDate(d.cover.activeUntil, lang),
            )}
          </div>
        )}
        <div className="py-3">
          <dt className="text-sm text-muted">{t.sponsor.receiptHash}</dt>
          <dd className="mt-1 font-mono text-[13px] break-all text-ink">{d.paymentHash}</dd>
        </div>
      </dl>
    </>
  );
}
