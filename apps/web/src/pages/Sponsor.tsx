import { SITES } from '@ndox/shared';
import { HandCoins, Users, Zap } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { npubEncode } from 'nostr-tools/nip19';
import { InvoiceQR } from '../components/InvoiceQR';
import { useToast } from '../components/Toast';
import { Badge, Button, ICON, LinkButton, MoneyBadge, PageTitle } from '../components/ui';
import { useI18n } from '../i18n';
import { api, ApiError, type Meta, type SponsorInvoice } from '../lib/api';
import { fmtDate, fmtEurFromFcfa, fmtFcfa } from '../lib/format';
import { useApi } from '../lib/useApi';

const PRESETS = [2000, 5000, 10000];

export default function Sponsor() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const meta = useApi<Meta>('/api/meta');
  const crews = useApi<{ items: { pseudonym: string; site: string }[] }>('/api/sponsor/crews');
  const [target, setTarget] = useState<'pool' | 'crew'>('pool');
  const [crew, setCrew] = useState('');
  const [amount, setAmount] = useState(5000);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [invoice, setInvoice] = useState<SponsorInvoice | null>(null);
  const [simulating, setSimulating] = useState(false);
  const ids = { target: useId(), amount: useId(), crew: useId(), custom: useId() };

  const value = custom ? Number.parseInt(custom, 10) : amount;
  const valid = Number.isInteger(value) && value >= 100 && value <= 5_000_000;
  const crewList = crews.data?.items ?? [];

  useEffect(() => {
    if (target === 'crew' && !crew && crewList[0]) setCrew(crewList[0].pseudonym);
  }, [target, crew, crewList]);

  // live "payé" state: poll while the invoice is open
  useEffect(() => {
    if (!invoice || invoice.status !== 'pending') return;
    const id = setInterval(() => {
      api
        .get<SponsorInvoice>(`/api/sponsor/invoice/${invoice.paymentHash}`)
        .then((v) => setInvoice((cur) => (cur ? { ...cur, ...v } : cur)))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [invoice]);

  async function create() {
    setBusy(true);
    try {
      const body =
        target === 'crew' && crew
          ? { amountFcfa: value, crewPseudonym: crew }
          : { amountFcfa: value };
      setInvoice(await api.send<SponsorInvoice>('POST', '/api/sponsor/invoice', body));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'generic';
      const errs = t.sponsor.errors;
      toast(code in errs ? errs[code as keyof typeof errs] : errs.generic, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function simulate() {
    if (!invoice) return;
    setSimulating(true);
    try {
      const v = await api.send<SponsorInvoice>(
        'POST',
        `/api/sponsor/invoice/${invoice.paymentHash}/simulate`,
      );
      setInvoice((cur) => (cur ? { ...cur, ...v } : cur));
    } catch (e) {
      const failed = e instanceof ApiError && e.code === 'test_payment_failed';
      toast(failed ? t.sponsor.errors.test_payment_failed : t.sponsor.errors.generic, 'error');
    } finally {
      setSimulating(false);
    }
  }

  if (invoice?.status === 'paid') {
    return (
      <>
        <PageTitle>{t.sponsor.thanksTitle}</PageTitle>
        <div className="flex flex-wrap items-center gap-2">
          <MoneyBadge simulated={invoice.simulated} testFunds={invoice.testFunds} />
        </div>
        <p className="mt-3 text-lg text-ink" data-testid="sponsor-thanks">
          {invoice.crew
            ? t.sponsor.thanksCrew(fmtFcfa(invoice.amountFcfa, lang), invoice.crew)
            : t.sponsor.thanksPool(fmtFcfa(invoice.amountFcfa, lang))}
        </p>
        {invoice.cover && (
          <p className="mt-2 text-muted">
            {t.sponsor.coverFrom(
              fmtDate(invoice.cover.activeFrom, lang),
              fmtDate(invoice.cover.activeUntil, lang),
            )}
          </p>
        )}
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <LinkButton href={`/soutenir/${invoice.paymentHash}`} variant="secondary">
            {t.sponsor.receipt}
          </LinkButton>
          <Button variant="ghost" onClick={() => setInvoice(null)}>
            {t.sponsor.another}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageTitle lead={t.sponsor.intro}>{t.sponsor.title}</PageTitle>

      {invoice ? (
        <>
          <InvoiceQR
            invoice={invoice.invoice ?? ''}
            status={invoice.status}
            amount={fmtFcfa(invoice.amountFcfa, lang)}
            demoPay={
              invoice.simulated
                ? 'simulate'
                : invoice.testFunds && meta.data?.demoPay === 'test'
                  ? 'test'
                  : null
            }
            onDemoPay={() => void simulate()}
            paying={simulating}
          />
          {invoice.crew && invoice.coverWeeks ? (
            <p className="mt-3 text-sm text-muted">
              {invoice.crew}: {t.sponsor.weeks(invoice.coverWeeks)}
            </p>
          ) : null}
          <Button variant="ghost" className="mt-4" onClick={() => setInvoice(null)}>
            {t.common.back}
          </Button>
        </>
      ) : (
        <form
          className="grid gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) void create();
          }}
        >
          <fieldset>
            <legend id={ids.target} className="mb-3 font-semibold text-ink">
              {t.sponsor.forWhom}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Choice
                name="target"
                checked={target === 'pool'}
                onChange={() => setTarget('pool')}
                icon={<HandCoins {...ICON} />}
                title={t.sponsor.pool}
                hint={t.sponsor.poolHint}
              />
              <Choice
                name="target"
                checked={target === 'crew'}
                onChange={() => setTarget('crew')}
                icon={<Users {...ICON} />}
                title={t.sponsor.crew}
                hint={t.sponsor.crewHint}
              />
            </div>
            {target === 'crew' && (
              <div className="mt-4">
                <label htmlFor={ids.crew} className="mb-1 block text-sm font-medium text-ink">
                  {t.sponsor.pickCrew}
                </label>
                {crewList.length === 0 ? (
                  <p className="text-sm text-muted">{t.sponsor.noCrews}</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      id={ids.crew}
                      value={crew}
                      onChange={(e) => setCrew(e.target.value)}
                      className="min-h-11 w-full rounded-btn border border-line bg-surface px-3 sm:w-auto"
                    >
                      {SITES.map((s) => {
                        const list = crewList.filter((c) => c.site === s.id);
                        return list.length ? (
                          <optgroup key={s.id} label={s.name}>
                            {list.map((c) => (
                              <option key={c.pseudonym} value={c.pseudonym}>
                                {c.pseudonym}
                              </option>
                            ))}
                          </optgroup>
                        ) : null;
                      })}
                    </select>
                    <Badge kind="demo" />
                  </div>
                )}
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend id={ids.amount} className="mb-3 font-semibold text-ink">
              {t.sponsor.amount}
            </legend>
            <div className="grid grid-cols-3 gap-2">
              {PRESETS.map((p) => (
                <label
                  key={p}
                  className={`flex min-h-16 cursor-pointer flex-col items-center justify-center rounded-btn border px-2 py-2 text-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ocean ${
                    !custom && amount === p
                      ? 'border-ocean bg-ocean-50 text-ocean'
                      : 'border-line bg-surface text-ink hover:border-ocean'
                  }`}
                >
                  <input
                    type="radio"
                    name="amount"
                    className="sr-only"
                    checked={!custom && amount === p}
                    onChange={() => {
                      setAmount(p);
                      setCustom('');
                    }}
                  />
                  <span className="tabular font-semibold">{fmtFcfa(p, lang)}</span>
                  <span className="tabular text-sm text-muted">
                    {t.sponsor.about(fmtEurFromFcfa(p, lang))}
                  </span>
                </label>
              ))}
            </div>
            <label htmlFor={ids.custom} className="mt-4 mb-1 block text-sm font-medium text-ink">
              {t.sponsor.otherAmount}
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <input
                id={ids.custom}
                inputMode="numeric"
                pattern="[0-9]*"
                value={custom}
                onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 7))}
                className="tabular min-h-11 w-40 rounded-btn border border-line bg-surface px-3"
                placeholder="20000"
              />
              {custom && valid && (
                <span className="tabular text-sm text-muted">
                  {t.sponsor.about(fmtEurFromFcfa(value, lang))}
                </span>
              )}
            </div>
          </fieldset>

          <div>
            <Button type="submit" disabled={!valid || busy || (target === 'crew' && !crew)}>
              {busy ? t.sponsor.creating : t.sponsor.create}
            </Button>
          </div>
        </form>
      )}

      {/* zaps carry real sats: a test-network pool cannot receive them */}
      {meta.data?.poolLightningAddress && !meta.data.testFunds && (
        <section aria-labelledby="zap" className="mt-12 border-t border-line pt-8">
          <h2 id="zap" className="flex items-center gap-2 text-lg font-semibold text-ink">
            <Zap {...ICON} />
            {t.sponsor.zapTitle}
          </h2>
          <p className="mt-2 text-muted">{t.sponsor.zapBody}</p>
          <p className="mt-3 font-mono text-sm break-all text-ink">
            {meta.data.poolLightningAddress}
          </p>
          <p className="mt-1 font-mono text-[13px] break-all text-muted">
            {npubEncode(meta.data.poolPubkey)}
          </p>
        </section>
      )}
    </>
  );
}

function Choice({
  name,
  checked,
  onChange,
  icon,
  title,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-card border p-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ocean ${
        checked ? 'border-ocean bg-ocean-50' : 'border-line bg-surface hover:border-ocean'
      }`}
    >
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} />
      <span className={checked ? 'text-ocean' : 'text-muted'}>{icon}</span>
      <span>
        <span className="block font-medium text-ink">{title}</span>
        <span className="block text-sm text-muted">{hint}</span>
      </span>
    </label>
  );
}
