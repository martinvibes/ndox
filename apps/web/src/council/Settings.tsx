import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useToast } from '../components/Toast';
import {
  Button,
  ErrorState,
  MoneyBadge,
  PageTitle,
  SectionTitle,
  Skeleton,
} from '../components/ui';
import { useI18n } from '../i18n';
import { ApiError } from '../lib/api';
import type { AdminSettings, PolicySettings } from '../lib/api';
import { fmtInt } from '../lib/format';
import { useApi } from '../lib/useApi';
import { useSession } from './session';

const INPUT = 'tabular min-h-11 w-full rounded-btn border border-line bg-surface px-3';
const FIELDS: { key: keyof PolicySettings; step: number; min: number }[] = [
  { key: 'payoutFcfa', step: 100, min: 100 },
  { key: 'waitingHours', step: 1, min: 0 },
  { key: 'premiumLoading', step: 0.05, min: 0 },
  { key: 'dailyPayoutCapSats', step: 1000, min: 0 },
  { key: 'reserveFloorSats', step: 1000, min: 0 },
];

type SiteDraft = { id: string; name: string; thresholdM: number; enabled: boolean };

export default function Settings() {
  const { t, lang } = useI18n();
  const { send } = useSession();
  const toast = useToast();
  const id = useId();
  const res = useApi<AdminSettings>('/api/admin/settings');
  const [policy, setPolicy] = useState<PolicySettings | null>(null);
  const [sites, setSites] = useState<SiteDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!res.data) return;
    setPolicy(res.data.policy);
    setSites(
      res.data.sites.map(({ id, name, thresholdM, enabled }) => ({
        id,
        name,
        thresholdM,
        enabled,
      })),
    );
  }, [res.data]);

  const labels: Record<keyof PolicySettings, string> = {
    payoutFcfa: t.council.settings.payoutFcfa,
    waitingHours: t.council.settings.waitingHours,
    premiumLoading: t.council.settings.premiumLoading,
    dailyPayoutCapSats: t.council.settings.dailyCap,
    reserveFloorSats: t.council.settings.reserveFloor,
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!policy || !res.data) return;
    setBusy(true);
    setError(null);
    const before = res.data;
    const changedPolicy = Object.fromEntries(
      FIELDS.filter((f) => policy[f.key] !== before.policy[f.key]).map((f) => [
        f.key,
        policy[f.key],
      ]),
    );
    const changedSites = sites.filter((s) => {
      const b = before.sites.find((x) => x.id === s.id);
      return !b || b.thresholdM !== s.thresholdM || b.enabled !== s.enabled;
    });
    try {
      const next = await send<AdminSettings>('PUT', '/api/admin/settings', {
        ...(Object.keys(changedPolicy).length ? { policy: changedPolicy } : {}),
        ...(changedSites.length
          ? {
              sites: changedSites.map(({ id, thresholdM, enabled }) => ({
                id,
                thresholdM,
                enabled,
              })),
            }
          : {}),
      });
      res.set(next);
      toast(t.council.settings.saved);
    } catch (err) {
      setError(err instanceof ApiError && err.detail ? err.detail : t.sponsor.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  if (res.error && !res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data || !policy) return <Skeleton className="h-96" />;
  const defaults = res.data.defaults;

  return (
    <>
      <PageTitle>{t.council.settings.title}</PageTitle>
      <form onSubmit={(e) => void save(e)} className="grid gap-12">
        <section aria-labelledby={`${id}-policy`}>
          <SectionTitle
            aside={
              <MoneyBadge
                simulated={res.data.wallet.simulated}
                testFunds={res.data.wallet.testFunds}
              />
            }
          >
            <span id={`${id}-policy`}>{t.council.settings.policy}</span>
          </SectionTitle>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="grid content-start gap-1.5">
                <label htmlFor={`${id}-${f.key}`} className="text-sm font-medium text-ink">
                  {labels[f.key]}
                </label>
                <input
                  id={`${id}-${f.key}`}
                  type="number"
                  inputMode="decimal"
                  min={f.min}
                  step={f.step}
                  required
                  value={policy[f.key]}
                  onChange={(e) => setPolicy({ ...policy, [f.key]: Number(e.target.value) })}
                  aria-describedby={`${id}-${f.key}-d`}
                  className={INPUT}
                />
                <p id={`${id}-${f.key}-d`} className="text-sm text-muted">
                  {t.council.settings.defaultValue(
                    f.key === 'premiumLoading'
                      ? String(defaults[f.key])
                      : fmtInt(defaults[f.key], lang),
                  )}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby={`${id}-sites`}>
          <SectionTitle>
            <span id={`${id}-sites`}>{t.council.settings.sites}</span>
          </SectionTitle>
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-muted">
                  <th scope="col" className="px-4 py-2.5 text-left font-medium">
                    {t.council.crews.site}
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-left font-medium">
                    {t.council.settings.threshold}
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-left font-medium">
                    {t.council.settings.enabled}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sites.map((s, i) => {
                  const patch = (p: Partial<SiteDraft>) =>
                    setSites(sites.map((x, j) => (j === i ? { ...x, ...p } : x)));
                  return (
                    <tr key={s.id}>
                      <th scope="row" className="px-4 py-2 text-left font-medium text-ink">
                        {s.name}
                      </th>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          min={1}
                          max={6}
                          step={0.1}
                          required
                          value={s.thresholdM}
                          onChange={(e) => patch({ thresholdM: Number(e.target.value) })}
                          aria-label={`${t.council.settings.threshold}, ${s.name}`}
                          className={`${INPUT} w-28`}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={s.enabled}
                          onChange={(e) => patch({ enabled: e.target.checked })}
                          aria-label={`${t.council.settings.enabled}, ${s.name}`}
                          className="h-5 w-5 accent-ocean"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="flex items-center gap-4">
          <Button type="submit" disabled={busy}>
            {t.council.settings.save}
          </Button>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </div>
      </form>
    </>
  );
}
