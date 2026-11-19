import { useI18n } from '../i18n';
import { fmtInt } from '../lib/format';

export interface SeasonValue {
  season: string;
  value: number;
}

/**
 * Hand-rolled SVG bar chart (docs/BRIEF.md §10.2: no chart library). One bar per season, a
 * dashed line for the mean; small multiples share `max` so sites compare honestly.
 */
export function SeasonBars({
  data,
  max,
  mean,
  label,
}: {
  data: SeasonValue[];
  max: number;
  mean: number;
  label: string;
}) {
  const { lang } = useI18n();
  const W = 640;
  const H = 120;
  const pad = { top: 8, bottom: 18, left: 28 };
  const plotH = H - pad.top - pad.bottom;
  const step = (W - pad.left) / data.length;
  const bw = Math.max(2, step * 0.7);
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;
  const ticks = [0, Math.round(max / 2), max];
  const worst = Math.max(...data.map((d) => d.value));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label}>
      {ticks.map((tk) => (
        <g key={tk}>
          <line x1={pad.left} x2={W} y1={y(tk)} y2={y(tk)} stroke="var(--color-line)" />
          <text
            x={pad.left - 6}
            y={y(tk) + 4}
            textAnchor="end"
            className="fill-muted"
            fontSize="11"
          >
            {fmtInt(tk, lang)}
          </text>
        </g>
      ))}
      {data.map((d, i) => (
        <rect
          key={d.season}
          x={pad.left + i * step + (step - bw) / 2}
          y={y(d.value)}
          width={bw}
          height={Math.max(0, y(0) - y(d.value))}
          rx={1.5}
          fill={d.value === worst && worst > 0 ? 'var(--color-danger)' : 'var(--color-ocean)'}
        >
          <title>{`${d.season}: ${d.value}`}</title>
        </rect>
      ))}
      <line
        x1={pad.left}
        x2={W}
        y1={y(mean)}
        y2={y(mean)}
        stroke="var(--color-ink)"
        strokeDasharray="4 3"
        strokeWidth={1.25}
      />
      {[0, data.length - 1].map((i) => (
        <text
          key={i}
          x={pad.left + i * step + step / 2}
          y={H - 4}
          textAnchor={i === 0 ? 'start' : 'end'}
          className="fill-muted"
          fontSize="11"
        >
          {data[i]?.season}
        </text>
      ))}
    </svg>
  );
}
