import { CheckCircle2, MessageSquareText, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { useI18n } from '../i18n';
import type { ModelValue, ReplayResult } from '../lib/api';
import { fmtDate, fmtFcfa, fmtSat, fmtTime, shortHex } from '../lib/format';
import { Badge, ICON } from './ui';
import { verifyHref } from './StatusCard';
import { WaveGauge } from './WaveGauge';

const STEP_MS = 1100;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Reveal `total` steps one after another; everything at once when motion is reduced. */
function useReveal(total: number, runKey: string): number {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? total : 1));
  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(total);
      return;
    }
    setShown(1);
    let n = 1;
    const id = setInterval(() => {
      n += 1;
      setShown(n);
      if (n >= total) clearInterval(id);
    }, STEP_MS);
    return () => clearInterval(id);
  }, [total, runKey]);
  return shown;
}

/** Count from 0 to `target` once `active` turns true (ease-out, 1.2 s). */
function useCountUp(target: number, active: boolean): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion() || target === 0) {
      setV(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 1200);
      setV(Math.round(target * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active]);
  return v;
}

interface FetchModel {
  model: string;
  ok: boolean;
  windowMaxM?: number | null;
  validHours?: number;
}

const OUTCOME_TEXT = {
  danger: 'text-danger',
  calme: 'text-calm',
  indisponible: 'text-muted',
  pending: 'text-muted',
} as const;

/**
 * The replay "money shot" (docs/BRIEF.md §10.4): commitment the evening before, the swell read
 * at dawn, the signed result, the payouts, and the SMS step that is not wired yet.
 */
export function Timeline({ result, thresholdM }: { result: ReplayResult; thresholdM: number }) {
  const { t, lang } = useI18n();
  const r = result.replay;
  const p = result.payouts;
  const step = (id: 'announce' | 'fetch' | 'attest') => r.steps.find((s) => s.step === id);
  const announce = step('announce');
  const fetch = step('fetch');
  const attest = step('attest');
  const shown = useReveal(5, r.runId);

  const models: ModelValue[] = ((fetch?.detail.models as FetchModel[] | undefined) ?? []).map(
    (m) => ({
      id: m.model,
      windowMaxM: m.ok ? (m.windowMaxM ?? null) : null,
      validHours: m.validHours ?? 0,
    }),
  );
  const paid = p?.payouts.filter((x) => x.status === 'paid') ?? [];
  const totalFcfa = paid.reduce((a, x) => a + x.amountFcfa, 0);
  const counted = useCountUp(totalFcfa, shown >= 4);
  const titles = [
    t.council.replay.steps.announce,
    t.council.replay.steps.fetch,
    t.council.replay.steps.attest,
    t.council.replay.steps.payouts,
    t.council.replay.steps.sms,
  ];

  const payoutsBody = (): ReactNode => {
    if (r.outcome !== 'danger')
      return <p className="text-muted">{t.council.replay.steps.payoutsNone}</p>;
    if (!r.verification.ok)
      return <p className="text-danger">{t.council.replay.steps.attestBad}</p>;
    if (!p || p.policies === 0)
      return <p className="text-muted">{t.council.replay.steps.payoutsNobody}</p>;
    return (
      <>
        <p
          className="tabular text-display font-semibold tracking-tight text-ink"
          data-testid="replay-total"
        >
          {fmtFcfa(counted, lang)}
        </p>
        <p className="mt-1 text-ink">
          {t.council.replay.steps.payoutsBody(paid.length, fmtFcfa(totalFcfa, lang))}
        </p>
        {p.shortfallSat > 0 && (
          <p className="mt-1 text-sm text-warn">
            {t.council.replay.steps.shortfall(fmtSat(p.shortfallSat, lang))}
          </p>
        )}
        <ul className="mt-3 grid gap-1 text-sm">
          {p.payouts.map((x) => (
            <li
              key={x.policyId}
              className="flex items-center justify-between gap-4 border-b border-line py-1.5 last:border-0"
            >
              <span className="text-ink">{x.pseudonym}</span>
              <span className="tabular flex items-center gap-2">
                {fmtFcfa(x.amountFcfa, lang)}
                {x.status === 'paid' ? (
                  <CheckCircle2
                    size={16}
                    strokeWidth={1.75}
                    className="text-calm"
                    aria-label={t.council.payoutStatus.paid}
                  />
                ) : (
                  <span className="text-danger">{t.council.payoutStatus.failed}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  };

  const rows: { time: string; body: ReactNode; muted?: boolean }[] = [
    {
      time: announce ? `${fmtDate(announce.at, lang)} ${fmtTime(announce.at)}` : '',
      body: (
        <p className="text-muted">
          {t.council.replay.steps.announceBody(
            shortHex(String(announce?.detail.noncePoint ?? ''), 10, 6),
          )}
        </p>
      ),
    },
    {
      time: fetch ? fmtTime(fetch.at) : '',
      body: <WaveGauge models={models} thresholdM={thresholdM} />,
    },
    {
      time: attest ? fmtTime(attest.at) : '',
      body: (
        <>
          <p
            className={`text-display leading-none font-bold tracking-tight uppercase ${OUTCOME_TEXT[r.outcome]}`}
            data-testid="replay-outcome"
          >
            {t.outcome[r.outcome]}
          </p>
          <p
            className={`mt-3 flex items-center gap-2 ${r.verification.ok ? 'text-calm' : 'text-danger'}`}
          >
            {r.verification.ok ? <CheckCircle2 {...ICON} /> : <XCircle {...ICON} />}
            {r.verification.ok ? t.council.replay.steps.attestOk : t.council.replay.steps.attestBad}
          </p>
          <Link
            href={verifyHref(r.eventId)}
            className="mt-2 inline-block text-ocean underline underline-offset-4"
          >
            {t.council.replay.openVerify}
          </Link>
        </>
      ),
    },
    { time: p ? fmtTime(p.at) : '', body: payoutsBody() },
    {
      time: '',
      muted: true,
      body: (
        <p className="flex items-center gap-2 text-muted">
          <MessageSquareText {...ICON} />
          {t.council.replay.steps.smsBody}
        </p>
      ),
    },
  ];

  return (
    <div className="mt-8">
      <p className="sr-only" aria-live="polite">
        {titles.slice(0, shown).join('. ')}
      </p>
      <ol className="relative grid">
        {rows.map((row, i) => {
          const visible = i < shown;
          return (
            <li
              key={titles[i]}
              data-step={i}
              aria-hidden={!visible}
              className={`grid grid-cols-[1rem_1fr] gap-x-4 transition-opacity duration-500 motion-reduce:transition-none sm:grid-cols-[7rem_1rem_1fr] ${
                visible ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <span className="tabular hidden pt-0.5 text-right text-sm text-muted sm:block">
                {row.time}
              </span>
              <span className="relative flex justify-center" aria-hidden>
                <span
                  className={`relative z-10 mt-1.5 h-3 w-3 rounded-full ${
                    row.muted
                      ? 'border-2 border-dashed border-muted bg-bg'
                      : i === 2 && r.outcome === 'danger'
                        ? 'bg-danger'
                        : 'bg-ocean'
                  }`}
                />
                {i < rows.length - 1 && <span className="absolute top-5 bottom-0 w-px bg-line" />}
              </span>
              <div className="min-w-0 pb-10">
                <h3
                  className={`flex flex-wrap items-center gap-2 font-semibold ${row.muted ? 'text-muted' : 'text-ink'}`}
                >
                  {titles[i]}
                  {i === 3 && p && <Badge kind="simulated" />}
                  {i === 0 && <Badge kind="replay" />}
                </h3>
                <span className="tabular text-sm text-muted sm:hidden">{row.time}</span>
                <div className="mt-2">{row.body}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
