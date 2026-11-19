import type { SiteId } from './sites.js';

/**
 * ANACIM dangerous-swell alert days as reported in the press (not an official ANACIM archive).
 * Used for the alert-day check of the backtest: did the index fire at the named site?
 */
export interface AlertDay {
  date: string;
  sites: SiteId[];
  zone: string;
  source: string;
  url?: string;
  /** true for entries added after the initial brief (see docs/DECISIONS.md). */
  added?: boolean;
}

const COAST: SiteId[] = ['kayar', 'saint-louis', 'joal', 'soumbedioune'];
const GRANDE_COTE_DAKAR: SiteId[] = ['kayar', 'saint-louis', 'soumbedioune'];
const BMS_FEB_2026 = 'https://fr.allafrica.com/stories/202602240465.html';

export const PRESS_ALERT_DAYS: readonly AlertDay[] = [
  { date: '2025-01-22', sites: ['soumbedioune'], zone: 'Côte de Dakar', source: 'Presse' },
  { date: '2026-01-18', sites: COAST, zone: 'Toute la côte', source: 'Presse' },
  { date: '2026-01-19', sites: COAST, zone: 'Toute la côte', source: 'Presse' },
  { date: '2026-01-20', sites: COAST, zone: 'Toute la côte', source: 'Presse' },
  {
    date: '2026-02-05',
    sites: ['saint-louis', 'kayar'],
    zone: 'Saint-Louis, Kayar (au large, 60 km)',
    source: 'Presse',
  },
  {
    date: '2026-02-26',
    sites: GRANDE_COTE_DAKAR,
    zone: 'Dakar et Grande-Côte',
    source: 'ANACIM, BMS du 24/02/2026 (AllAfrica)',
    url: BMS_FEB_2026,
    added: true,
  },
  {
    date: '2026-02-27',
    sites: GRANDE_COTE_DAKAR,
    zone: 'Dakar et Grande-Côte',
    source: 'ANACIM, BMS du 24/02/2026 (AllAfrica)',
    url: BMS_FEB_2026,
    added: true,
  },
  {
    date: '2026-02-28',
    sites: COAST,
    zone: 'Toute la côte (Petite Côte à partir du 27/02 22 h)',
    source: 'ANACIM, BMS du 24/02/2026 (AllAfrica)',
    url: BMS_FEB_2026,
    added: true,
  },
  {
    date: '2026-05-12',
    sites: ['saint-louis'],
    zone: 'Saint-Louis',
    source: 'Presse',
    url: 'https://fr.allafrica.com/stories/202605120484.html',
  },
];

/** Days kept as replayable seed forecasts (alert days + days where both models crossed 2.5 m). */
export const REPLAY_DATES: readonly string[] = [
  '2025-12-14',
  '2025-12-15',
  '2026-01-18',
  '2026-01-19',
  '2026-01-20',
  '2026-01-29',
  '2026-02-05',
  '2026-02-26',
  '2026-02-27',
  '2026-02-28',
  '2026-04-09',
  '2026-05-12',
];

/** The day the demo replays by default: an ANACIM alert day where both models cross 2.5 m at Kayar. */
export const DEMO_REPLAY = { site: 'kayar' as SiteId, date: '2026-02-27' };
