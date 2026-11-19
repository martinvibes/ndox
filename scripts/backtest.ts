/**
 * pnpm backtest — reads data/seed (written by `pnpm data:fetch`), writes data/seed/backtest.json
 * and prints the season table and the alert-day matches.
 *
 * Caveat (shown in the UI too): the backtest uses ONE reanalysis model (ERA5-Ocean, 0.5°) while
 * the live trigger needs TWO forecast models (ECMWF WAM + NCEP GFS-Wave) to agree.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addDays,
  dailyAt,
  dangerDaysBySeason,
  decideOutcome,
  LIVE_MODELS,
  PRESS_ALERT_DAYS,
  seasonDays,
  SITES,
  summarize,
  weeklyPremiumFcfa,
  type DailySeries,
  type SiteConfig,
} from '@ndox/shared';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(ROOT, 'data/seed');

const PAYOUT_FCFA = Number(process.env.PAYOUT_FCFA ?? 2000);
const LOADING = Number(process.env.PREMIUM_LOADING ?? 0.25);
const MIN_VALID_HOURS = 10;
const FIRST_YEAR = 1995;
const LAST_YEAR = 2025;
const ALL_YEAR = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

interface Era5Seed {
  grid: { lat: number; lon: number };
  daily: DailySeries;
}
interface RecentModel {
  grid: { lat: number; lon: number };
  wave_height: DailySeries;
  swell_wave_height: DailySeries | null;
}
interface RecentSeed {
  models: Record<string, RecentModel>;
}

const readJson = async <T>(p: string) => JSON.parse(await readFile(p, 'utf8')) as T;

function inRange(season: string): boolean {
  const start = Number(season.slice(0, 4));
  const end = season.length > 4 ? start + 1 : start;
  return start >= FIRST_YEAR && end <= LAST_YEAR;
}

/** Max number of danger days in any 7 consecutive days. */
function worstWeek(d: DailySeries, threshold: number): number {
  const flags = d.maxM.map((m, i) =>
    m !== null && (d.valid[i] ?? 0) >= MIN_VALID_HOURS && m >= threshold ? 1 : 0,
  );
  let best = 0;
  let run = 0;
  for (let i = 0; i < flags.length; i++) {
    run += flags[i] as number;
    if (i >= 7) run -= flags[i - 7] as number;
    best = Math.max(best, run);
  }
  return best;
}

function seriesEnd(d: DailySeries): string {
  return addDays(d.start, d.maxM.length - 1);
}

function liveRuleOn(recent: RecentSeed, date: string, thresholdM: number) {
  const obs = LIVE_MODELS.map((id) => {
    const s = recent.models[id]?.wave_height;
    const v = s ? dailyAt(s, date) : undefined;
    return { id, windowMaxM: v?.maxM ?? null, validHours: v?.validHours ?? 0 };
  });
  const outcome = decideOutcome(
    { thresholdM, minValidHours: MIN_VALID_HOURS, models: LIVE_MODELS },
    obs,
  );
  return { outcome, models: obs };
}

function siteBacktest(site: SiteConfig, era5: Era5Seed, recent: RecentSeed) {
  const opts = {
    thresholdM: site.thresholdM,
    minValidHours: MIN_VALID_HOURS,
    seasonMonths: site.seasonMonths,
  };
  const seasons = dangerDaysBySeason(era5.daily, opts).filter((c) => inRange(c.season));
  const years = dangerDaysBySeason(era5.daily, { ...opts, seasonMonths: ALL_YEAR }).filter((c) =>
    inRange(c.season),
  );
  const summary = summarize(seasons.map((c) => c.dangerDays));
  const days = seasonDays(site.seasonMonths);
  const sensitivity = [2, 2.5, 3].map((t) => ({
    thresholdM: t,
    meanDangerDays: summarize(
      dangerDaysBySeason(era5.daily, { ...opts, thresholdM: t })
        .filter((c) => inRange(c.season))
        .map((c) => c.dangerDays),
    ).mean,
  }));

  // Live two-model rule over the period where both live models have archives.
  const ecmwf = recent.models.ecmwf_wam?.wave_height;
  const gfs = recent.models.ncep_gfswave025;
  let liveRule = null;
  if (ecmwf && gfs) {
    const from = ecmwf.start > gfs.wave_height.start ? ecmwf.start : gfs.wave_height.start;
    const to =
      seriesEnd(ecmwf) < seriesEnd(gfs.wave_height) ? seriesEnd(ecmwf) : seriesEnd(gfs.wave_height);
    const dangerDates: string[] = [];
    let unavailable = 0;
    let n = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      n++;
      const r = liveRuleOn(recent, d, site.thresholdM);
      if (r.outcome === 'danger') dangerDates.push(d);
      if (r.outcome === 'indisponible') unavailable++;
    }
    liveRule = { from, to, days: n, dangerDates, unavailableDays: unavailable };
  }

  // Swell vs total wave height — only GFS-Wave provides swell through Open-Meteo.
  let swell = null;
  if (gfs?.swell_wave_height) {
    const count = (s: DailySeries) =>
      s.maxM.filter(
        (m, i) => m !== null && (s.valid[i] ?? 0) >= MIN_VALID_HOURS && m >= site.thresholdM,
      ).length;
    swell = {
      model: 'ncep_gfswave025',
      from: gfs.wave_height.start,
      to: seriesEnd(gfs.wave_height),
      waveHeightDays: count(gfs.wave_height),
      swellWaveHeightDays: count(gfs.swell_wave_height),
    };
  }

  return {
    site: site.id,
    name: site.name,
    thresholdM: site.thresholdM,
    seasonMonths: site.seasonMonths,
    era5Grid: era5.grid,
    seasons: seasons.map(({ season, dangerDays, missingDays }) => ({
      season,
      dangerDays,
      missingDays,
    })),
    years: years.map(({ season, dangerDays }) => ({ year: Number(season), dangerDays })),
    summary,
    weeksInSeason: Math.round((days / 7) * 100) / 100,
    premiumWeeklyFcfa: weeklyPremiumFcfa({
      meanDangerDays: summary.mean,
      payoutFcfa: PAYOUT_FCFA,
      seasonDays: days,
      loading: LOADING,
    }),
    reservePerPolicyFcfa: summary.worst * PAYOUT_FCFA,
    worstWeekDangerDays: worstWeek(era5.daily, site.thresholdM),
    sensitivity,
    liveRule,
    swell,
  };
}

const era5: Record<string, Era5Seed> = {};
const recent: Record<string, RecentSeed> = {};
for (const s of SITES) {
  era5[s.id] = await readJson<Era5Seed>(join(SEED, 'era5', `${s.id}.json`));
  recent[s.id] = await readJson<RecentSeed>(join(SEED, 'recent', `${s.id}.json`));
}

const sites = SITES.map((s) => siteBacktest(s, era5[s.id] as Era5Seed, recent[s.id] as RecentSeed));

const rows = PRESS_ALERT_DAYS.flatMap((a) =>
  a.sites.map((siteId) => {
    const site = SITES.find((s) => s.id === siteId) as SiteConfig;
    const e = dailyAt((era5[siteId] as Era5Seed).daily, a.date);
    const era5Fired =
      e && e.maxM !== null && e.validHours >= MIN_VALID_HOURS ? e.maxM >= site.thresholdM : null;
    const live = liveRuleOn(recent[siteId] as RecentSeed, a.date, site.thresholdM);
    return {
      date: a.date,
      site: siteId,
      zone: a.zone,
      source: a.source,
      url: a.url ?? null,
      added: a.added ?? false,
      era5MaxM: e?.maxM ?? null,
      era5Fired,
      live: live.models.map((m) => ({ id: m.id, windowMaxM: m.windowMaxM })),
      liveOutcome: live.outcome,
    };
  }),
);

function rate(values: (boolean | null)[]) {
  const known = values.filter((v): v is boolean => v !== null);
  const matched = known.filter(Boolean).length;
  return {
    matched,
    total: known.length,
    rate: known.length ? Math.round((matched / known.length) * 1000) / 1000 : null,
  };
}

// Threshold calibration: how the alert match rate, danger-day frequency and premium move with the
// threshold. The live trigger keeps the brief's 2.5 m default until the CLPA calibrates per site.
const CALIBRATION_THRESHOLDS = [2, 2.25, 2.5, 2.75, 3];
const calibration = CALIBRATION_THRESHOLDS.map((t) => {
  const era5Hits: (boolean | null)[] = [];
  const liveHits: (boolean | null)[] = [];
  for (const a of PRESS_ALERT_DAYS) {
    for (const siteId of a.sites) {
      const e = dailyAt((era5[siteId] as Era5Seed).daily, a.date);
      era5Hits.push(e && e.maxM !== null && e.validHours >= MIN_VALID_HOURS ? e.maxM >= t : null);
      const live = liveRuleOn(recent[siteId] as RecentSeed, a.date, t);
      liveHits.push(live.outcome === 'indisponible' ? null : live.outcome === 'danger');
    }
  }
  return {
    thresholdM: t,
    alertMatchEra5: rate(era5Hits),
    alertMatchLive: rate(liveHits),
    sites: SITES.map((site) => {
      const seasons = dangerDaysBySeason((era5[site.id] as Era5Seed).daily, {
        thresholdM: t,
        minValidHours: MIN_VALID_HOURS,
        seasonMonths: site.seasonMonths,
      }).filter((c) => inRange(c.season));
      const mean = summarize(seasons.map((c) => c.dangerDays)).mean;
      const r = recent[site.id] as RecentSeed;
      const ecmwf = r.models.ecmwf_wam?.wave_height;
      let liveDangerDays = 0;
      if (ecmwf) {
        for (let d = ecmwf.start; d <= seriesEnd(ecmwf); d = addDays(d, 1)) {
          if (liveRuleOn(r, d, t).outcome === 'danger') liveDangerDays++;
        }
      }
      return {
        site: site.id,
        meanDangerDaysPerSeason: mean,
        premiumWeeklyFcfa: weeklyPremiumFcfa({
          meanDangerDays: mean,
          payoutFcfa: PAYOUT_FCFA,
          seasonDays: seasonDays(site.seasonMonths),
          loading: LOADING,
        }),
        liveRuleDangerDays: liveDangerDays,
      };
    }),
  };
});

const result = {
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  params: {
    historyModel: 'era5_ocean',
    liveModels: LIVE_MODELS,
    variable: 'wave_height',
    windowUtc: [6, 18],
    minValidHours: MIN_VALID_HOURS,
    payoutFcfa: PAYOUT_FCFA,
    loading: LOADING,
    years: [FIRST_YEAR, LAST_YEAR],
  },
  caveat:
    'Le backtest utilise un seul modèle de réanalyse (ERA5-Ocean, maille 0,5°) alors que le déclencheur en direct exige que deux modèles de prévision (ECMWF WAM et NCEP GFS-Wave) soient d’accord. La houle seule (swell) n’est disponible que via GFS-Wave depuis 2024.',
  sites,
  alertCheck: {
    note: 'Dates d’alerte ANACIM relevées dans la presse, pas une archive officielle.',
    rows,
    era5: rate(rows.map((r) => r.era5Fired)),
    live: rate(
      rows.map((r) => (r.liveOutcome === 'indisponible' ? null : r.liveOutcome === 'danger')),
    ),
  },
  calibration,
};

await writeFile(join(SEED, 'backtest.json'), JSON.stringify(result, null, 2) + '\n');

// ---- print ---------------------------------------------------------------
console.log(
  `\nNdox backtest — ERA5-Ocean ${FIRST_YEAR}–${LAST_YEAR}, wave_height 06–18 UTC max ≥ threshold\n`,
);
console.log('site           thr   seasons  mean   p90  worst  worst7d  premium/wk  reserve/policy');
for (const s of sites) {
  console.log(
    `${s.site.padEnd(14)} ${s.thresholdM.toFixed(1)}  ${String(s.summary.n).padStart(7)}  ${s.summary.mean.toFixed(1).padStart(5)}  ${String(s.summary.p90).padStart(4)}  ${String(s.summary.worst).padStart(5)}  ${String(s.worstWeekDangerDays).padStart(7)}  ${String(s.premiumWeeklyFcfa).padStart(6)} FCFA  ${String(s.reservePerPolicyFcfa).padStart(8)} FCFA`,
  );
}
console.log('\nLive two-model rule over the live models’ archive:');
for (const s of sites) {
  if (s.liveRule)
    console.log(
      `  ${s.site.padEnd(14)} ${s.liveRule.from} → ${s.liveRule.to}: ${s.liveRule.dangerDates.length} danger day(s) ${s.liveRule.dangerDates.join(', ')}`,
    );
}
console.log('\nSwell vs total wave height (GFS-Wave only):');
for (const s of sites) {
  if (s.swell)
    console.log(
      `  ${s.site.padEnd(14)} ${s.swell.from} → ${s.swell.to}: wave_height ${s.swell.waveHeightDays} d, swell_wave_height ${s.swell.swellWaveHeightDays} d`,
    );
}
console.log('\nAlert-day check (press-reported ANACIM alerts):');
console.log('date        site           ERA5 max  ERA5   ECMWF  GFS    live rule');
for (const r of rows) {
  const [a, b] = r.live;
  const f = (v: number | null | undefined) =>
    v === null || v === undefined ? '  -  ' : v.toFixed(2);
  console.log(
    `${r.date}  ${r.site.padEnd(13)}  ${f(r.era5MaxM).padStart(6)}  ${r.era5Fired === null ? '  -  ' : r.era5Fired ? ' oui ' : ' non '}  ${f(a?.windowMaxM)}  ${f(b?.windowMaxM)}  ${r.liveOutcome}`,
  );
}
const pct = (x: { rate: number | null }) =>
  x.rate === null ? 'n/a' : `${Math.round(x.rate * 100)} %`;
console.log(
  '\nThreshold calibration (alert match rate · mean ERA5 danger days per season · live-rule days since Nov 2025):',
);
for (const c of calibration) {
  console.log(
    `  ${c.thresholdM.toFixed(2)} m  ERA5 ${pct(c.alertMatchEra5).padStart(5)}  live ${pct(c.alertMatchLive).padStart(5)}  ` +
      c.sites
        .map(
          (s) =>
            `${s.site} ${s.meanDangerDaysPerSeason.toFixed(1)}d/${s.liveRuleDangerDays}d ${s.premiumWeeklyFcfa}F`,
        )
        .join('  '),
  );
}
console.log(
  `\nMatch rate — ERA5 index: ${result.alertCheck.era5.matched}/${result.alertCheck.era5.total} (${pct(result.alertCheck.era5)}); live two-model rule: ${result.alertCheck.live.matched}/${result.alertCheck.live.total} (${pct(result.alertCheck.live)})\n`,
);
