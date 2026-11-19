import { MODEL_INFO, getSite } from '@ndox/shared';
import { ArrowLeft, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { CheckList, type CheckListItem } from '../components/CheckList';
import { DataTable } from '../components/DataTable';
import { EquivocationDemo } from '../components/EquivocationDemo';
import { OutcomeBadge } from '../components/OutcomeBadge';
import { useToast } from '../components/Toast';
import { Badge, Button, ErrorState, ICON, Skeleton } from '../components/ui';
import { useI18n } from '../i18n';
import type { AttestationDetail, Meta, Outcome } from '../lib/api';
import { fmtDate, fmtDateTime, fmtFcfa, fmtM, fmtSat, shortHex } from '../lib/format';
import { useApi } from '../lib/useApi';
import type { CheckId, CheckResult } from '../verify/checks';

const ORDER: CheckId[] = ['relays', 'nonce', 'signature', 'data', 'rule', 'payments'];

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.text();
}

interface Published {
  outcome: Outcome;
  thresholdM: number;
  models: { id: string; windowMaxM: number | null; validHours: number; sha256: string }[];
}

function readPublished(d: AttestationDetail): Published | null {
  if (!d.attestation) return null;
  try {
    const att = JSON.parse(d.attestation.event.content) as {
      outcome: Outcome;
      data: { models: Published['models'] };
    };
    const ann = JSON.parse(d.announcement.event.content) as { rule: { thresholdM: number } };
    return { outcome: att.outcome, thresholdM: ann.rule.thresholdM, models: att.data.models };
  } catch {
    return null;
  }
}

export default function VerifyEvent({ eventId }: { eventId: string }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const detail = useApi<AttestationDetail>(`/api/attestations/${encodeURIComponent(eventId)}`);
  const meta = useApi<Meta>('/api/meta');
  const [results, setResults] = useState<Partial<Record<CheckId, CheckResult>>>({});
  const [proofs, setProofs] = useState<Record<string, boolean>>({});
  const [round, setRound] = useState(0);
  const d = detail.data;
  const m = meta.data;

  useEffect(() => {
    if (!d?.attestation || !m) return;
    let live = true;
    const put = (r: CheckResult) => live && setResults((x) => ({ ...x, [r.id]: r }));
    setResults({});
    void (async () => {
      const c = await import('../verify/checks');
      let parsed: ReturnType<typeof c.parseDetail>;
      try {
        parsed = c.parseDetail(d);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        c.parseFailure().forEach(put);
        return;
      }
      const [nonce, sig] = c.checkOracle(d, m);
      put(nonce);
      put(sig);
      put(c.checkRule(parsed));
      put(c.checkPayments(d, m.poolPubkey));
      if (live)
        setProofs(
          Object.fromEntries(
            d.payouts
              .filter((x) => x.preimage && x.paymentHash)
              .map((x) => [x.id, c.preimageMatches(x.preimage!, x.paymentHash!)]),
          ),
        );
      void c.checkData(d, parsed, fetchText).then(put);
      void c.checkRelays(d, m, c.nostrRelayQuery).then(put);
    })();
    return () => {
      live = false;
    };
  }, [d, m, round]);

  const published = useMemo(() => (d ? readPublished(d) : null), [d]);

  if (detail.error?.status === 404 || detail.error?.status === 400) {
    return (
      <>
        <BackLink />
        <p className="text-lg font-semibold text-ink">{t.event.notFound}</p>
      </>
    );
  }
  if (detail.error && !d) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  if (!d) return <Skeleton className="h-80" />;

  const siteName = getSite(d.site)?.name ?? d.site;
  const ck = t.event.checks;
  const item = (id: CheckId): CheckListItem => {
    const r = results[id];
    const base = { id, state: r?.state ?? ('running' as const) };
    switch (id) {
      case 'relays':
        return {
          ...base,
          label: ck.relays,
          detail:
            r?.id !== 'relays'
              ? undefined
              : r.state === 'ok'
                ? ck.relaysOk(r.found)
                : r.state === 'skip'
                  ? r.reason === 'replay'
                    ? ck.relaysReplay
                    : ck.relaysDryRun
                  : ck.relaysMissing,
        };
      case 'nonce':
        return {
          ...base,
          label: ck.nonce,
          detail:
            r?.id === 'nonce' && r.windowStart
              ? ck.nonceDetail(fmtDateTime(r.committedAt, lang), fmtDateTime(r.windowStart, lang))
              : undefined,
        };
      case 'signature':
        return {
          ...base,
          label: ck.signature,
          tech: ck.signatureTech,
          detail:
            r?.id === 'signature'
              ? r.failed.length
                ? r.failed.join(', ')
                : ck.signatureKey(shortHex(r.oraclePubkey, 12, 8))
              : undefined,
        };
      case 'data':
        return {
          ...base,
          label: ck.data,
          tech: ck.dataTech,
          detail:
            r?.id === 'data'
              ? r.failed.length
                ? r.failed.map((x) => MODEL_INFO[x]?.label ?? x).join(', ')
                : ck.dataDetail(r.checked)
              : undefined,
        };
      case 'rule':
        return {
          ...base,
          label: ck.rule,
          detail: r?.id === 'rule' ? ck.ruleDetail(t.outcome[r.recomputed]) : undefined,
        };
      case 'payments':
        return {
          ...base,
          label: ck.payments,
          tech: ck.paymentsTech,
          detail:
            r?.id === 'payments'
              ? r.total === 0
                ? ck.paymentsNone
                : ck.paymentsDetail(r.valid, r.total)
              : undefined,
        };
    }
  };
  const items = ORDER.map(item);
  const done = items.every((i) => i.state !== 'running');
  const failed = items.some((i) => i.state === 'fail');

  return (
    <>
      <BackLink />
      <header className="mb-8">
        <div className="flex flex-wrap items-center gap-2">
          {d.replay && <Badge kind="replay" />}
          {d.payoutRun?.simulated && <Badge kind="simulated" />}
        </div>
        <h1 className="mt-2 text-title font-semibold tracking-tight text-ink sm:text-display">
          {t.event.title(siteName, fmtDate(d.date, lang, 'long'))}
        </h1>
        <p className="mt-2 font-mono text-[13px] break-all text-muted">{d.eventId}</p>
      </header>

      {!d.attestation || !published ? (
        <p className="rounded-card border border-line bg-surface px-4 py-3 text-ink">
          {t.event.notAttested}
        </p>
      ) : (
        <>
          <section
            aria-labelledby="result"
            className="rounded-card border border-line bg-surface p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="result" className="font-semibold text-ink">
                {t.event.resultTitle}
              </h2>
              <OutcomeBadge outcome={published.outcome} />
            </div>
            <p className="mt-1 text-sm text-muted">
              {t.event.rule(fmtM(published.thresholdM, lang))}
            </p>
            <div className="mt-3 -mx-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-line text-muted">
                    <th scope="col" className="px-4 py-2 text-left font-medium">
                      {t.event.model}
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      {t.event.windowMax}
                    </th>
                    <th
                      scope="col"
                      className="hidden px-4 py-2 text-right font-medium sm:table-cell"
                    >
                      {t.event.validHours}
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      {t.event.raw}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {published.models.map((mo) => {
                    const rec = d.forecasts.find((f) => f.model === mo.id);
                    const over = mo.windowMaxM !== null && mo.windowMaxM >= published.thresholdM;
                    return (
                      <tr key={mo.id}>
                        <td className="px-4 py-2">{MODEL_INFO[mo.id]?.label ?? mo.id}</td>
                        <td
                          className={`tabular px-4 py-2 text-right font-semibold ${over ? 'text-danger' : 'text-ink'}`}
                        >
                          {fmtM(mo.windowMaxM, lang)}
                        </td>
                        <td className="tabular hidden px-4 py-2 text-right sm:table-cell">
                          {mo.validHours}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {rec?.rawUrl ? (
                            <a
                              href={rec.rawUrl}
                              className="inline-flex items-center gap-1 font-mono text-[13px] text-ocean hover:underline"
                              title={`SHA-256 ${mo.sha256}`}
                            >
                              {mo.sha256.slice(0, 8)}
                              <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="checks" className="mt-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="checks" className="text-lg font-semibold text-ink">
                {t.event.checksTitle}
              </h2>
              <Button
                variant="ghost"
                className="min-h-9 text-sm"
                onClick={() => setRound((n) => n + 1)}
                disabled={!done}
              >
                <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
                {t.event.rerun}
              </Button>
            </div>
            <p
              className={`mt-2 font-medium ${!done ? 'text-muted' : failed ? 'text-danger' : 'text-calm'}`}
              aria-live="polite"
              data-testid="verify-summary"
              data-done={done}
              data-failed={failed}
            >
              {!done ? t.event.running : failed ? t.event.someFailed : t.event.allOk}
            </p>
            <div className="mt-2 rounded-card border border-line bg-surface px-4">
              <CheckList items={items} label={t.event.checksTitle} />
            </div>
          </section>

          <section aria-labelledby="payments" className="mt-8">
            <h2 id="payments" className="mb-3 text-lg font-semibold text-ink">
              {t.event.paymentsTitle}
            </h2>
            {d.payouts.length === 0 ? (
              <p className="text-muted">{t.event.paymentsNone}</p>
            ) : (
              <DataTable
                caption={t.event.paymentsTitle}
                rows={d.payouts}
                rowKey={(p) => p.id}
                columns={[
                  {
                    key: 'amount',
                    header: t.event.amount,
                    cell: (p) => (
                      <span className="tabular">
                        <span className="font-medium text-ink">{fmtFcfa(p.amountFcfa, lang)}</span>
                        <span className="block text-muted">{fmtSat(p.amountSat, lang)}</span>
                      </span>
                    ),
                  },
                  {
                    key: 'status',
                    header: t.event.payment,
                    cell: (p) => (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {t.council.payoutStatus[p.status]}
                        {p.simulated && <Badge kind="simulated" />}
                      </span>
                    ),
                  },
                  {
                    key: 'proof',
                    header: <span title={t.event.proofHint}>{t.event.proof}</span>,
                    cell: (p) =>
                      p.preimage && p.paymentHash ? (
                        <span title={`preimage ${p.preimage}\npayment_hash ${p.paymentHash}`}>
                          <span className="font-mono text-[13px] text-muted">
                            {shortHex(p.paymentHash, 6, 4)}
                          </span>{' '}
                          {p.id in proofs && (
                            <span className={proofs[p.id] ? 'text-calm' : 'text-danger'}>
                              {proofs[p.id] ? t.event.proofOk : t.event.proofBad}
                            </span>
                          )}
                        </span>
                      ) : (
                        '—'
                      ),
                  },
                ]}
              />
            )}
          </section>
        </>
      )}

      <section aria-labelledby="events" className="mt-8">
        <h2 id="events" className="mb-3 text-lg font-semibold text-ink">
          {t.event.eventsTitle}
        </h2>
        <dl className="divide-y divide-line rounded-card border border-line bg-surface px-4">
          <EventId label={t.event.announcement} id={d.announcement.event.id} toast={toast} />
          {d.attestation && (
            <EventId label={t.event.attestation} id={d.attestation.event.id} toast={toast} />
          )}
        </dl>
      </section>

      <EquivocationDemo />
    </>
  );
}

function EventId({
  label,
  id,
  toast,
}: {
  label: string;
  id: string;
  toast: ReturnType<typeof useToast>;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        <span className="font-mono text-[13px] text-ink" title={id}>
          {shortHex(id, 12, 8)}
        </span>
        <button
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center rounded-btn text-muted hover:text-ocean"
          aria-label={`${t.common.copy} ${label}`}
          onClick={() =>
            void navigator.clipboard?.writeText(id).then(
              () => toast(t.common.copied),
              () => {},
            )
          }
        >
          <Copy {...ICON} size={16} />
        </button>
      </dd>
    </div>
  );
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Link
      href="/verifier"
      className="-ml-2 mb-4 inline-flex min-h-11 items-center gap-1 rounded-btn px-2 text-sm text-muted hover:text-ink"
    >
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
      {t.verify.title}
    </Link>
  );
}
