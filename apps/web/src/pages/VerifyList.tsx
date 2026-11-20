import { ChevronRight, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { getSite } from '@ndox/shared';
import { Link } from 'wouter';
import { DataTable } from '../components/DataTable';
import { EquivocationDemo } from '../components/EquivocationDemo';
import { OutcomeBadge } from '../components/OutcomeBadge';
import { verifyHref } from '../components/StatusCard';
import { Badge, EmptyState, ErrorState, PageTitle, Skeleton } from '../components/ui';
import { useI18n } from '../i18n';
import type { AttestationSummary, Meta } from '../lib/api';
import { fmtDate, fmtM } from '../lib/format';
import { useApi } from '../lib/useApi';

export default function VerifyList() {
  const { t, lang } = useI18n();
  // `/verifier?tab=rejeux` opens on the replays (the home page links there before the first attestation).
  const [replay, setReplay] = useState(
    () => new URLSearchParams(window.location.search).get('tab') === 'rejeux',
  );
  const list = useApi<{ items: AttestationSummary[] }>(
    `/api/attestations?limit=50&replay=${replay ? 1 : 0}`,
  );
  const meta = useApi<Meta>('/api/meta');
  const tabs = [
    { value: false, label: t.verify.live },
    { value: true, label: t.verify.replays },
  ];

  return (
    <>
      <PageTitle lead={t.verify.intro}>{t.verify.title}</PageTitle>

      <div role="tablist" aria-label={t.verify.title} className="mb-4 flex gap-1">
        {tabs.map((tab) => (
          <button
            key={String(tab.value)}
            role="tab"
            type="button"
            aria-selected={replay === tab.value}
            onClick={() => setReplay(tab.value)}
            className={`min-h-11 rounded-btn px-4 text-sm font-medium ${
              replay === tab.value
                ? 'bg-ink text-white'
                : 'text-muted hover:bg-surface hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {list.error && !list.data ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : !list.data ? (
          <Skeleton className="h-48" />
        ) : list.data.items.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={t.verify.emptyTitle}
            body={
              replay
                ? t.verify.emptyReplays
                : t.verify.emptyBody(`${meta.data?.schedule.attest ?? '05:15'}\u00a0GMT`)
            }
          />
        ) : (
          <DataTable
            caption={replay ? t.verify.replays : t.verify.live}
            rows={list.data.items}
            rowKey={(r) => r.eventId}
            columns={[
              {
                key: 'date',
                header: t.verify.date,
                cell: (r) => (
                  <span className="tabular whitespace-nowrap">{fmtDate(r.date, lang)}</span>
                ),
              },
              {
                key: 'site',
                header: t.verify.site,
                cell: (r) => (
                  <span className="inline-flex items-center gap-2">
                    {getSite(r.site)?.name ?? r.site}
                    {r.replay && <Badge kind="replay" />}
                  </span>
                ),
              },
              {
                key: 'outcome',
                header: t.verify.result,
                cell: (r) => <OutcomeBadge outcome={r.outcome} />,
              },
              {
                key: 'm',
                header: t.verify.measured,
                align: 'right',
                wide: true,
                cell: (r) => fmtM(r.decisiveM, lang),
              },
              {
                key: 'go',
                header: <span className="sr-only">{t.verify.check}</span>,
                align: 'right',
                cell: (r) => (
                  <Link
                    href={verifyHref(r.eventId)}
                    className="-my-2 inline-flex min-h-11 items-center gap-1 font-medium text-ocean hover:underline"
                  >
                    {t.verify.check}
                    <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
                  </Link>
                ),
              },
            ]}
          />
        )}
      </div>

      <EquivocationDemo />
    </>
  );
}
