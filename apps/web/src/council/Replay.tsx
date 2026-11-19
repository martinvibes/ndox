import { DEMO_REPLAY, PRESS_ALERT_DAYS, REPLAY_DATES, SITES } from '@ndox/shared';
import { Play, RotateCcw } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Timeline } from '../components/Timeline';
import { Button, ICON, PageTitle } from '../components/ui';
import { useI18n } from '../i18n';
import { ApiError } from '../lib/api';
import type { ReplayResult } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useApi } from '../lib/useApi';
import { useSession } from './session';

const INPUT = 'min-h-11 w-full rounded-btn border border-line bg-surface px-3';
const DATES = [...REPLAY_DATES].sort().reverse();

const isAlertDay = (site: string, date: string) =>
  PRESS_ALERT_DAYS.some((d) => d.date === date && (d.sites as readonly string[]).includes(site));

export default function Replay() {
  const { t, lang } = useI18n();
  const { send } = useSession();
  const id = useId();
  const sites = useApi<{ id: string; thresholdM: number }[]>('/api/sites');
  const [site, setSite] = useState<string>(DEMO_REPLAY.site);
  const [date, setDate] = useState<string>(DEMO_REPLAY.date);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);

  async function run(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await send<ReplayResult>('POST', '/api/admin/replay', { site, date }));
    } catch (err) {
      const errs = t.council.replay.errors as Record<string, string>;
      setError((err instanceof ApiError && errs[err.code]) || errs.generic || null);
    } finally {
      setBusy(false);
    }
  }

  const threshold =
    sites.data?.find((s) => s.id === (result?.replay.site ?? site))?.thresholdM ?? 2.5;

  return (
    <>
      <PageTitle lead={t.council.replay.body}>{t.council.replay.title}</PageTitle>
      <form
        onSubmit={(e) => void run(e)}
        className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-site`} className="text-sm font-medium text-ink">
            {t.council.replay.site}
          </label>
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
        </div>
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-date`} className="text-sm font-medium text-ink">
            {t.council.replay.date}
          </label>
          <select
            id={`${id}-date`}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={INPUT}
          >
            {DATES.map((d) => (
              <option key={d} value={d}>
                {fmtDate(d, lang, 'long')}
                {isAlertDay(site, d) ? ` (${t.council.replay.alertDay})` : ''}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={busy} data-testid="replay-run">
          {result ? <RotateCcw {...ICON} /> : <Play {...ICON} />}
          {busy ? t.council.replay.running : result ? t.council.replay.again : t.council.replay.run}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-4 text-danger">
          {error}
        </p>
      )}
      {busy && !result && (
        <p className="mt-8 text-muted" aria-live="polite">
          {t.council.replay.running}
        </p>
      )}
      {result && <Timeline result={result} thresholdM={threshold} />}
    </>
  );
}
