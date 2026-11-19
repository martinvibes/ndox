export type SiteId = 'kayar' | 'saint-louis' | 'joal' | 'soumbedioune';

export interface SiteConfig {
  id: SiteId;
  name: string;
  /** Short label for SMS (ASCII, ≤ 12 chars). */
  smsName: string;
  /** Offshore point used for the marine grid cell (see docs/DECISIONS.md). */
  lat: number;
  lon: number;
  /** Fishing season months (1–12). */
  seasonMonths: number[];
  /** Default danger threshold (metres). */
  thresholdM: number;
  /** Single-letter prefix for crew status codes. */
  codePrefix: string;
  /** Point used for the ERA5-Ocean backtest when the 0.5° cell at (lat, lon) straddles the coast. */
  era5?: { lat: number; lon: number };
}

const ALL_YEAR = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export const SITES: readonly SiteConfig[] = [
  {
    id: 'kayar',
    name: 'Kayar',
    smsName: 'Kayar',
    lat: 14.95,
    lon: -17.2,
    seasonMonths: [12, 1, 2, 3, 4, 5, 6],
    thresholdM: 2.5,
    codePrefix: 'K',
  },
  {
    id: 'saint-louis',
    name: 'Saint-Louis (Guet Ndar)',
    smsName: 'Saint-Louis',
    lat: 16.02,
    // brief: -16.60; GFS-Wave 0.25° returns 0.00 m (land cell) there, nudged offshore.
    lon: -16.7,
    seasonMonths: ALL_YEAR,
    thresholdM: 2.5,
    codePrefix: 'S',
    // ERA5's 0.5° cell for (16.02, -16.70) is centred on the coast (16.0, -16.5) and damped.
    era5: { lat: 16.02, lon: -17.0 },
  },
  {
    id: 'joal',
    name: 'Joal-Fadiouth',
    smsName: 'Joal',
    lat: 14.15,
    lon: -16.95,
    seasonMonths: ALL_YEAR,
    thresholdM: 2.5,
    codePrefix: 'J',
  },
  {
    id: 'soumbedioune',
    name: 'Soumbédioune (Dakar)',
    smsName: 'Soumbedioune',
    lat: 14.68,
    lon: -17.5,
    seasonMonths: ALL_YEAR,
    thresholdM: 2.5,
    codePrefix: 'D',
  },
];

export const SITE_IDS = SITES.map((s) => s.id) as readonly SiteId[];

export function getSite(id: string): SiteConfig | undefined {
  return SITES.find((s) => s.id === id);
}

export function isSiteId(id: string): id is SiteId {
  return SITES.some((s) => s.id === id);
}
