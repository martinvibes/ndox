import { MODEL_INFO } from '@ndox/shared';
import { useI18n } from '../i18n';
import { fmtM } from '../lib/format';
import type { ModelValue } from '../lib/api';

/**
 * Each model's 06–18 GMT maximum against the site threshold, drawn like a tide staff: one bar per
 * model and a single threshold line running through all of them. Danger needs every bar past it.
 */
export function WaveGauge({ models, thresholdM }: { models: ModelValue[]; thresholdM: number }) {
  const { t, lang } = useI18n();
  const top = Math.max(thresholdM * 1.6, ...models.map((m) => (m.windowMaxM ?? 0) * 1.08));
  const pct = (m: number) => Math.min(100, (m / top) * 100);
  const tx = pct(thresholdM);
  const label = (id: string) => MODEL_INFO[id]?.label ?? id;

  return (
    <figure className="m-0">
      <figcaption className="sr-only">
        {t.common.threshold(fmtM(thresholdM, lang))}.{' '}
        {models
          .map(
            (m) =>
              `${label(m.id)} : ${m.windowMaxM === null ? t.home.missing : fmtM(m.windowMaxM, lang)}`,
          )
          .join('. ')}
      </figcaption>
      <div
        className="grid grid-cols-[minmax(0,7.5rem)_1fr_auto] items-center gap-x-3 text-sm"
        aria-hidden
      >
        <div className="flex flex-col">
          {models.map((m) => (
            <span key={m.id} className="flex h-7 items-center truncate text-muted">
              {label(m.id)}
            </span>
          ))}
        </div>
        <div className="relative">
          {models.map((m) => {
            const over = m.windowMaxM !== null && m.windowMaxM >= thresholdM;
            return (
              <div key={m.id} className="flex h-7 items-center">
                <div className="h-2 w-full overflow-hidden rounded-full bg-line">
                  {m.windowMaxM !== null && (
                    <div
                      className={`h-full rounded-full ${over ? 'bg-danger' : 'bg-ocean'}`}
                      style={{ width: `${pct(m.windowMaxM)}%` }}
                    />
                  )}
                </div>
              </div>
            );
          })}
          <div
            className="pointer-events-none absolute -top-1 -bottom-1 border-l-[1.5px] border-dashed border-ink"
            style={{ left: `${tx}%` }}
            aria-hidden
          />
        </div>
        <div className="flex flex-col items-end">
          {models.map((m) => {
            const over = m.windowMaxM !== null && m.windowMaxM >= thresholdM;
            return (
              <span
                key={m.id}
                className={`tabular flex h-7 items-center font-semibold ${over ? 'text-danger' : 'text-ink'}`}
              >
                {m.windowMaxM === null ? t.home.missing : fmtM(m.windowMaxM, lang)}
              </span>
            );
          })}
        </div>
        <span />
        <div className="relative h-5">
          <span
            className="tabular absolute top-0.5 -translate-x-1/2 whitespace-nowrap text-muted"
            style={{ left: `${tx}%` }}
          >
            {t.common.threshold(fmtM(thresholdM, lang))}
          </span>
        </div>
        <span />
      </div>
    </figure>
  );
}
