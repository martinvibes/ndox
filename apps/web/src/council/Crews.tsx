import { SITES } from '@ndox/shared';
import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { DataTable } from '../components/DataTable';
import { InvoiceQR } from '../components/InvoiceQR';
import { useToast } from '../components/Toast';
import { Badge, Button, ErrorState, SectionTitle, Skeleton } from '../components/ui';
import { useI18n } from '../i18n';
import type { Messages } from '../i18n/fr';
import { api, ApiError } from '../lib/api';
import type { AdminCrew, AdminDeposit, AdminPolicy } from '../lib/api';
import { fmtDate, fmtFcfa, hoursUntil } from '../lib/format';
import type { Lang } from '../lib/format';
import { useApi } from '../lib/useApi';
import { useSession } from './session';

const siteName = (id: string) => SITES.find((s) => s.id === id)?.name ?? id;
const INPUT = 'min-h-11 w-full rounded-btn border border-line bg-surface px-3';

export function policyText(t: Messages, lang: Lang, p: AdminPolicy | null): string {
  const s = t.council.crews.state;
  if (!p) return s.none;
  switch (p.state) {
    case 'awaiting_premium':
      return s.awaiting_premium;
    case 'waiting':
      return s.waiting(p.activeFrom ? Math.max(0, hoursUntil(p.activeFrom)) : 0);
    case 'covered':
      return s.covered(p.activeUntil ? fmtDate(p.activeUntil, lang) : '—');
    case 'expired':
      return s.expired;
    case 'cancelled':
      return s.cancelled;
  }
}

export default function Crews() {
  const { t, lang } = useI18n();
  const { send } = useSession();
  const toast = useToast();
  const res = useApi<{ items: AdminCrew[] }>('/api/admin/crews');
  const [premiumFor, setPremiumFor] = useState<AdminCrew | null>(null);
  const items = res.data?.items;

  async function toggle(c: AdminCrew) {
    try {
      await send('PATCH', `/api/admin/crews/${c.id}`, { active: !c.active });
      res.reload();
    } catch {
      toast(t.sponsor.errors.generic, 'error');
    }
  }

  return (
    <div className="grid gap-12">
      <h1 className="sr-only">{t.council.crews.title}</h1>
      <Enrol onDone={res.reload} />

      <section aria-labelledby="crew-list">
        <SectionTitle>
          <span id="crew-list">{t.council.crews.list}</span>
        </SectionTitle>
        {res.error && !items ? (
          <ErrorState error={res.error} onRetry={res.reload} />
        ) : !items ? (
          <Skeleton className="h-40" />
        ) : items.length === 0 ? (
          <p className="text-muted">{t.council.crews.empty}</p>
        ) : (
          <DataTable
            caption={t.council.crews.list}
            rows={items}
            rowKey={(c) => c.id}
            columns={[
              {
                key: 'crew',
                header: t.council.overview.crew,
                cell: (c) => (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={c.active ? 'font-medium text-ink' : 'text-muted line-through'}>
                      {c.pseudonym}
                    </span>
                    {c.demo && <Badge kind="demo" />}
                    {!c.active && (
                      <span className="text-xs text-muted">{t.council.crews.inactive}</span>
                    )}
                  </span>
                ),
              },
              { key: 'site', header: t.council.crews.site, cell: (c) => siteName(c.site) },
              {
                key: 'code',
                header: t.council.crews.code,
                wide: true,
                cell: (c) => <span className="font-mono text-xs">{c.statusCode}</span>,
              },
              {
                key: 'ln',
                header: t.council.crews.lnAddress,
                wide: true,
                cell: (c) => (
                  <span className="font-mono text-xs text-muted">{c.lnAddressHint ?? '—'}</span>
                ),
              },
              {
                key: 'cover',
                header: t.council.crews.cover,
                cell: (c) => (
                  <span
                    className={
                      c.policy?.state === 'covered'
                        ? 'text-calm'
                        : c.policy?.state === 'awaiting_premium'
                          ? 'text-warn'
                          : 'text-muted'
                    }
                  >
                    {policyText(t, lang, c.policy)}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: <span className="sr-only">{t.council.crews.actions}</span>,
                cell: (c) => (
                  <span className="flex justify-end gap-2">
                    {c.active && (
                      <Button
                        variant="secondary"
                        className="min-h-9 px-3 text-sm"
                        onClick={() => setPremiumFor(c)}
                        aria-label={t.council.crews.premiumFor(c.pseudonym)}
                      >
                        {t.council.crews.newPremium}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="min-h-9 px-3 text-sm"
                      onClick={() => void toggle(c)}
                    >
                      {c.active ? t.council.crews.deactivate : t.council.crews.activate}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        )}
      </section>

      {premiumFor && (
        <Premium
          key={premiumFor.id}
          crew={premiumFor}
          onClose={() => setPremiumFor(null)}
          onPaid={res.reload}
        />
      )}
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

function Enrol({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const { send, session } = useSession();
  const toast = useToast();
  const id = useId();
  const [site, setSite] = useState<string>(SITES[0]!.id);
  const [lnAddress, setLn] = useState('');
  const [phone, setPhone] = useState('');
  const [pseudonym, setPseudonym] = useState('');
  // money that is not real (simulated or test sats) can only cover demo crews sensibly
  const [demo, setDemo] = useState(
    session.wallet ? session.wallet.simulated || session.wallet.testFunds : true,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const crew = await send<AdminCrew>('POST', '/api/admin/crews', {
        site,
        lnAddress: lnAddress.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(pseudonym.trim() ? { pseudonym: pseudonym.trim() } : {}),
        demo,
      });
      toast(t.council.crews.enrolled(crew.pseudonym));
      setLn('');
      setPhone('');
      setPseudonym('');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.detail ? err.detail : t.sponsor.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="enrol">
      <SectionTitle>
        <span id="enrol">{t.council.crews.enrolTitle}</span>
      </SectionTitle>
      <p className="mb-5 max-w-[62ch] text-muted">{t.council.crews.enrolBody}</p>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field id={`${id}-site`} label={t.council.crews.site}>
          <select
            id={`${id}-site`}
            value={site}
            onChange={(e) => setSite(e.target.value)}
            className={INPUT}
          >
            {SITES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${id}-ln`} label={t.council.crews.lnAddress}>
          <input
            id={`${id}-ln`}
            required
            minLength={3}
            maxLength={320}
            autoComplete="off"
            spellCheck={false}
            inputMode="email"
            placeholder="nom@portefeuille.com"
            value={lnAddress}
            onChange={(e) => setLn(e.target.value)}
            className={INPUT}
          />
        </Field>
        <Field id={`${id}-phone`} label={t.council.crews.phone}>
          <input
            id={`${id}-phone`}
            type="tel"
            autoComplete="off"
            maxLength={32}
            placeholder="+221 77 000 00 00"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={INPUT}
          />
        </Field>
        <Field
          id={`${id}-ps`}
          label={t.council.crews.pseudonym}
          hint={t.council.crews.pseudonymHint}
        >
          <input
            id={`${id}-ps`}
            maxLength={40}
            autoComplete="off"
            value={pseudonym}
            onChange={(e) => setPseudonym(e.target.value)}
            aria-describedby={`${id}-ps-hint`}
            className={INPUT}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-4 sm:col-span-2 lg:col-span-4">
          <label className="flex min-h-11 items-center gap-2 text-ink">
            <input
              type="checkbox"
              checked={demo}
              onChange={(e) => setDemo(e.target.checked)}
              className="h-5 w-5 accent-ocean"
            />
            {t.council.crews.demo}
          </label>
          <Button type="submit" disabled={busy || lnAddress.trim().length < 3} className="ml-auto">
            {t.council.crews.enrol}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger sm:col-span-2 lg:col-span-4">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

function Premium({
  crew,
  onClose,
  onPaid,
}: {
  crew: AdminCrew;
  onClose: () => void;
  onPaid: () => void;
}) {
  const { t, lang } = useI18n();
  const { send, session } = useSession();
  const toast = useToast();
  const id = useId();
  const [weeks, setWeeks] = useState(4);
  const [deposit, setDeposit] = useState<AdminDeposit | null>(null);
  const [busy, setBusy] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll the invoice until it settles; the wallet is the source of truth, not this page.
  const hash = deposit?.status === 'pending' ? deposit.paymentHash : null;
  useEffect(() => {
    if (!hash) return;
    const timer = setInterval(() => {
      api
        .get<AdminDeposit>(`/api/admin/deposits/${hash}`)
        .then(setDeposit)
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [hash]);

  const paid = deposit?.status === 'paid';
  useEffect(() => {
    if (!paid) return;
    toast(t.council.crews.paidToast);
    onPaid();
  }, [paid, toast, t, onPaid]);

  async function issue(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await send<{ policy: AdminPolicy; deposit: AdminDeposit | null }>(
        'POST',
        '/api/admin/policies',
        { crewId: crew.id, weeks, invoice: true },
      );
      if (!r.deposit) setError(t.sponsor.errors.wallet_unavailable);
      setDeposit(r.deposit);
      onPaid();
    } catch {
      setError(t.sponsor.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  async function simulate() {
    if (!deposit?.paymentHash) return;
    setSimulating(true);
    try {
      setDeposit(
        await send<AdminDeposit>('POST', `/api/admin/deposits/${deposit.paymentHash}/simulate`),
      );
    } catch (e) {
      const failed = e instanceof ApiError && e.code === 'test_payment_failed';
      toast(failed ? t.sponsor.errors.test_payment_failed : t.sponsor.errors.generic, 'error');
    } finally {
      setSimulating(false);
    }
  }

  return (
    <section
      aria-labelledby="premium"
      className="rounded-card border border-line bg-surface p-4 sm:p-6"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <h2 id="premium" className="text-lg font-semibold text-ink">
          {t.council.crews.premiumFor(crew.pseudonym)}
        </h2>
        <Button variant="ghost" className="min-h-9 px-3 text-sm" onClick={onClose}>
          {t.council.crews.close}
        </Button>
      </div>
      {!deposit?.invoice ? (
        <form onSubmit={(e) => void issue(e)} className="flex flex-wrap items-end gap-4">
          <Field id={`${id}-w`} label={t.council.crews.weeks}>
            <input
              id={`${id}-w`}
              type="number"
              min={1}
              max={52}
              step={1}
              value={weeks}
              onChange={(e) =>
                setWeeks(Math.min(52, Math.max(1, Math.trunc(Number(e.target.value) || 1))))
              }
              className={`${INPUT} w-28`}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {t.council.crews.issue}
          </Button>
          {error && (
            <p role="alert" className="w-full text-sm text-danger">
              {error}
            </p>
          )}
        </form>
      ) : (
        <InvoiceQR
          invoice={deposit.invoice}
          status={deposit.status}
          amount={fmtFcfa(deposit.amountFcfa, lang)}
          demoPay={
            deposit.simulated
              ? 'simulate'
              : deposit.testFunds && session.wallet?.demoPay === 'test'
                ? 'test'
                : null
          }
          onDemoPay={() => void simulate()}
          paying={simulating}
        />
      )}
    </section>
  );
}
