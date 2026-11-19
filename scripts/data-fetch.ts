/**
 * pnpm data:fetch [--only era5|recent|forecasts] [--force]
 *
 * Downloads wave data from the Open-Meteo Marine API and writes compact, committed seed files
 * so the app and the backtest run offline:
 *   data/seed/era5/<site>.json          ERA5-Ocean daily 06–18 UTC max, 1995 → today-6d
 *   data/seed/recent/<site>.json        live models' daily max over their archive (ECMWF WAM, GFS-Wave)
 *   data/seed/forecasts/<date>/<site>/<model>.json   raw responses (+ URL, fetch time, SHA-256) for replays
 * Raw ERA5 yearly responses are cached in data/raw/ (git-ignored).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dailyWindowMaxima,
  HISTORY_MODEL,
  LIVE_MODELS,
  marineUrl,
  parseMarineResponse,
  REPLAY_DATES,
  seriesFromResponse,
  SITES,
  type DailySeries,
  type MarineResponse,
} from '@ndox/shared';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(ROOT, 'data/seed');
const RAW = join(ROOT, 'data/raw');
const FIRST_YEAR = 1995;

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const force = args.includes('--force');

export interface Envelope {
  url: string;
  fetchedAt: string;
  sha256: string;
  body: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => isoDate(new Date(Date.now() - n * 86_400_000));

async function fetchEnvelope(url: string): Promise<Envelope> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'ndox-data-fetch/0.1' } });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      parseMarineResponse(body); // throws on API errors
      return { url, fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), sha256: sha256(body), body };
    } catch (err) {
      lastErr = err;
      await sleep(1000 * attempt * attempt);
    }
  }
  throw lastErr;
}

async function cachedEnvelope(path: string, url: string): Promise<Envelope> {
  if (!force && existsSync(path)) {
    const env = JSON.parse(await readFile(path, 'utf8')) as Envelope;
    if (env.url === url) return env;
  }
  const env = await fetchEnvelope(url);
  await writeJson(path, env);
  await sleep(250);
  return env;
}

async function writeJson(path: string, data: unknown, pretty = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, pretty ? 2 : undefined) + '\n');
}

const round2 = (s: DailySeries): DailySeries => ({
  ...s,
  maxM: s.maxM.map((v) => (v === null ? null : Math.round(v * 100) / 100)),
});

function concatHourly(responses: MarineResponse[], variable: string) {
  const time: string[] = [];
  const values: (number | null)[] = [];
  for (const r of responses) {
    const s = seriesFromResponse(r, variable);
    time.push(...s.time);
    values.push(...s.values);
  }
  return { time, values };
}

async function fetchEra5(): Promise<void> {
  const lastDay = daysAgo(6); // ERA5 has a ~5-day delay
  const lastYear = Number(lastDay.slice(0, 4));
  for (const site of SITES) {
    const sources: { year: number; url: string; fetchedAt: string; sha256: string }[] = [];
    const responses: MarineResponse[] = [];
    for (let y = FIRST_YEAR; y <= lastYear; y++) {
      const endDate = y === lastYear ? lastDay : `${y}-12-31`;
      const point = site.era5 ?? site;
      const url = marineUrl({
        lat: point.lat,
        lon: point.lon,
        model: HISTORY_MODEL,
        startDate: `${y}-01-01`,
        endDate,
        variables: ['wave_height'],
      });
      const env = await cachedEnvelope(join(RAW, 'era5', site.id, `${y}.json`), url);
      sources.push({ year: y, url: env.url, fetchedAt: env.fetchedAt, sha256: env.sha256 });
      responses.push(parseMarineResponse(env.body));
      process.stdout.write(`\rera5 ${site.id} ${y}   `);
    }
    const first = responses[0] as MarineResponse;
    const { time, values } = concatHourly(responses, 'wave_height');
    await writeJson(join(SEED, 'era5', `${site.id}.json`), {
      site: site.id,
      model: HISTORY_MODEL,
      variable: 'wave_height',
      windowUtc: [6, 18],
      requested: site.era5 ?? { lat: site.lat, lon: site.lon },
      grid: { lat: first.latitude, lon: first.longitude },
      note: 'ERA5-Ocean via Open-Meteo does not provide swell_wave_height.',
      sources,
      daily: round2(dailyWindowMaxima(time, values)),
    });
  }
  process.stdout.write('\n');
}

async function fetchRecent(): Promise<void> {
  const until = daysAgo(1);
  const starts: Record<string, string> = { ecmwf_wam: '2025-11-01', ncep_gfswave025: '2024-06-01' };
  for (const site of SITES) {
    const models: Record<string, unknown> = {};
    for (const model of LIVE_MODELS) {
      const url = marineUrl({
        lat: site.lat,
        lon: site.lon,
        model,
        startDate: starts[model] as string,
        endDate: until,
      });
      const env = await cachedEnvelope(join(RAW, 'recent', site.id, `${model}.json`), url);
      const resp = parseMarineResponse(env.body);
      const wave = seriesFromResponse(resp, 'wave_height');
      const swell = seriesFromResponse(resp, 'swell_wave_height');
      models[model] = {
        grid: { lat: resp.latitude, lon: resp.longitude },
        source: { url: env.url, fetchedAt: env.fetchedAt, sha256: env.sha256 },
        wave_height: round2(dailyWindowMaxima(wave.time, wave.values)),
        swell_wave_height: swell.values.some((v) => v !== null)
          ? round2(dailyWindowMaxima(swell.time, swell.values))
          : null,
      };
      process.stdout.write(`\rrecent ${site.id} ${model}        `);
    }
    await writeJson(join(SEED, 'recent', `${site.id}.json`), {
      site: site.id,
      windowUtc: [6, 18],
      requested: { lat: site.lat, lon: site.lon },
      models,
    });
  }
  process.stdout.write('\n');
}

async function fetchForecasts(): Promise<void> {
  for (const date of REPLAY_DATES) {
    for (const site of SITES) {
      for (const model of LIVE_MODELS) {
        const url = marineUrl({ lat: site.lat, lon: site.lon, model, startDate: date, endDate: date });
        const path = join(SEED, 'forecasts', date, site.id, `${model}.json`);
        await cachedEnvelope(path, url);
        process.stdout.write(`\rforecast ${date} ${site.id} ${model}        `);
      }
    }
  }
  process.stdout.write('\n');
}

if (!only || only === 'era5') await fetchEra5();
if (!only || only === 'recent') await fetchRecent();
if (!only || only === 'forecasts') await fetchForecasts();
console.log('data:fetch done');
