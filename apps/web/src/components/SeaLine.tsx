/**
 * The brand drawing: a swell drifting past a dashed saffron threshold. Where a crest rises above
 * the line it turns red, which is the whole rule in one picture. Decorative (aria-hidden); the
 * caption under it says the rule in words.
 */
const W = 1200;
const H = 150;
const T = 52; // threshold height (y)

function wave(): { line: string; area: string } {
  const pts: string[] = [];
  for (let x = 0; x <= 2 * W; x += 8) {
    const a = (2 * Math.PI * x) / W;
    const y = 86 - 30 * Math.sin(3 * a) - 15 * Math.sin(5 * a + 1.1) - 10 * Math.sin(2 * a + 0.4);
    pts.push(`${x},${y.toFixed(1)}`);
  }
  const line = `M${pts.join(' L')}`;
  return { line, area: `${line} L${2 * W},${H} L0,${H} Z` };
}

const { line, area } = wave();

export function SeaLine({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={`block h-28 w-full sm:h-36 ${className}`}
      aria-hidden
    >
      <defs>
        <clipPath id="sea-above">
          <rect x="0" y="0" width={W} height={T} />
        </clipPath>
        <linearGradient id="sea-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-ocean)" stopOpacity=".16" />
          <stop offset="1" stopColor="var(--color-ocean)" stopOpacity=".02" />
        </linearGradient>
      </defs>
      <g className="sea-drift">
        <path d={area} fill="url(#sea-fill)" />
        <path
          d={line}
          fill="none"
          stroke="var(--color-ocean)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </g>
      <g clipPath="url(#sea-above)">
        <g className="sea-drift">
          <path d={area} fill="var(--color-danger)" fillOpacity=".14" />
          <path
            d={line}
            fill="none"
            stroke="var(--color-danger)"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      </g>
      <line
        x1="0"
        x2={W}
        y1={T}
        y2={T}
        stroke="var(--color-saffron)"
        strokeWidth="2"
        strokeDasharray="7 7"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
