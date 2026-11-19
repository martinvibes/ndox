/**
 * Open-Meteo Marine API helpers (https://open-meteo.com/en/docs/marine-weather-api).
 * Model IDs verified against the live API on 2026-11-19 (see docs/DECISIONS.md).
 */

export const MARINE_ENDPOINT = 'https://marine-api.open-meteo.com/v1/marine';

/** The two independent forecast models the live trigger requires. */
export const LIVE_MODELS = ['ecmwf_wam', 'ncep_gfswave025'] as const;
export type LiveModelId = (typeof LIVE_MODELS)[number];

/** Reanalysis used for the 1995–2025 backtest. */
export const HISTORY_MODEL = 'era5_ocean';

export const MODEL_INFO: Record<string, { label: string; detail: string }> = {
  ecmwf_wam: { label: 'ECMWF WAM', detail: '9 km, hourly' },
  ncep_gfswave025: { label: 'NCEP GFS-Wave', detail: '0.25°, hourly' },
  era5_ocean: { label: 'ERA5-Ocean', detail: 'reanalysis, 0.5°, hourly' },
};

export type WaveVariable = 'wave_height' | 'swell_wave_height';
export const WAVE_VARIABLES: readonly WaveVariable[] = ['wave_height', 'swell_wave_height'];

export interface MarineQuery {
  lat: number;
  lon: number;
  model: string;
  startDate: string;
  endDate: string;
  variables?: readonly string[];
}

/** Deterministic request URL (stable parameter order), so the URL itself can be published. */
export function marineUrl(q: MarineQuery): string {
  const vars = q.variables ?? WAVE_VARIABLES;
  const params = [
    `latitude=${q.lat.toFixed(2)}`,
    `longitude=${q.lon.toFixed(2)}`,
    `hourly=${vars.join(',')}`,
    `models=${q.model}`,
    `timezone=GMT`,
    `start_date=${q.startDate}`,
    `end_date=${q.endDate}`,
  ];
  return `${MARINE_ENDPOINT}?${params.join('&')}`;
}

export interface MarineResponse {
  latitude: number;
  longitude: number;
  hourly: { time: string[] } & Record<string, (number | null)[] | string[]>;
}

/** Parses a raw Open-Meteo body; throws on API errors or unexpected shapes. */
export function parseMarineResponse(body: string): MarineResponse {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('Open-Meteo response is not JSON');
  }
  if (typeof json !== 'object' || json === null) throw new Error('unexpected response');
  const o = json as Record<string, unknown>;
  if (o.error === true) throw new Error(`Open-Meteo error: ${String(o.reason ?? 'unknown')}`);
  const hourly = o.hourly as Record<string, unknown> | undefined;
  if (!hourly || !Array.isArray(hourly.time)) throw new Error('response has no hourly.time');
  if (typeof o.latitude !== 'number' || typeof o.longitude !== 'number') {
    throw new Error('response has no coordinates');
  }
  return json as MarineResponse;
}

/** Extracts one hourly variable; variables the model does not provide come back as nulls. */
export function seriesFromResponse(
  resp: MarineResponse,
  variable: string,
): { time: string[]; values: (number | null)[] } {
  const time = resp.hourly.time;
  const raw = resp.hourly[variable];
  const values: (number | null)[] = Array.isArray(raw)
    ? raw.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
    : time.map(() => null);
  return { time, values };
}
