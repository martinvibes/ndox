import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';
import type { EquivocationDemo as Demo } from '../verify/equivocation';
import { Button, ICON } from './ui';

function Row({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[13rem_1fr] sm:gap-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd
        className={`font-mono text-[13px] break-all ${tone === 'danger' ? 'font-semibold text-danger' : 'text-ink'}`}
      >
        {value}
      </dd>
    </div>
  );
}

/** "Pourquoi l'oracle ne peut pas mentir": a throwaway key recovered from two signatures. */
export function EquivocationDemo() {
  const { t } = useI18n();
  const [demo, setDemo] = useState<Demo | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const { runEquivocationDemo } = await import('../verify/equivocation');
      setDemo(runEquivocationDemo());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="equivocation" className="mt-12 border-t border-line pt-8">
      <h2 id="equivocation" className="text-lg font-semibold text-ink">
        {t.equivocation.title}
      </h2>
      <p className="mt-2 max-w-[62ch] text-muted">{t.equivocation.body}</p>
      <Button className="mt-4" variant="secondary" onClick={run} disabled={busy}>
        <KeyRound {...ICON} />
        {demo ? t.equivocation.again : t.equivocation.run}
      </Button>
      <div aria-live="polite">
        {demo && (
          <dl className="mt-5 divide-y divide-line rounded-card border border-line bg-surface px-4">
            <Row label={t.equivocation.secret} value={demo.secret} />
            <Row label={t.equivocation.nonce} value={demo.noncePoint} />
            <Row label={t.equivocation.sigCalm} value={demo.sigCalm} />
            <Row label={t.equivocation.sigDanger} value={demo.sigDanger} />
            <Row label={t.equivocation.recovered} value={demo.recovered} tone="danger" />
            <div className="py-3">
              <p className="font-medium text-danger" data-testid="equivocation-result">
                {demo.recovered === demo.secret ? t.equivocation.match : '—'}
              </p>
              <p className="mt-1 font-mono text-[13px] text-muted">{t.equivocation.formula}</p>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}
