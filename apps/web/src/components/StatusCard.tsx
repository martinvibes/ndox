import { ChevronRight, CircleSlash, Clock, TriangleAlert, Waves } from 'lucide-react';
import { Link } from 'wouter';
import { useI18n } from '../i18n';
import { fmtTime } from '../lib/format';
import type { TodaySite } from '../lib/api';
import { WaveGauge } from './WaveGauge';
import { ICON } from './ui';

type State = 'calme' | 'danger' | 'indisponible' | 'pending' | 'off';

const LOOK: Record<State, { band: string; word: string; Icon: typeof Waves }> = {
  calme: { band: 'bg-calm-bg', word: 'text-calm', Icon: Waves },
  danger: { band: 'bg-danger-bg', word: 'text-danger', Icon: TriangleAlert },
  indisponible: { band: 'bg-warn-bg', word: 'text-warn', Icon: CircleSlash },
  pending: { band: 'bg-bg', word: 'text-muted', Icon: Clock },
  off: { band: 'bg-bg', word: 'text-muted', Icon: CircleSlash },
};

export const verifyHref = (eventId: string) => `/verifier/${encodeURIComponent(eventId)}`;

/** One landing site today: the big honest status, both model values against the threshold. */
export function StatusCard({ site, attestTime }: { site: TodaySite; attestTime: string }) {
  const { t } = useI18n();
  const att = site.attestation;
  const state: State = att ? att.outcome : site.enabled ? 'pending' : 'off';
  const { band, word, Icon } = LOOK[state];
  const label =
    state === 'pending'
      ? t.outcome.pending
      : state === 'off'
        ? t.home.notFollowed
        : t.outcome[state];

  return (
    <article
      className="flex flex-col overflow-hidden rounded-card border border-line bg-surface"
      aria-labelledby={`site-${site.id}`}
      data-testid={`status-${site.id}`}
    >
      <div className={`px-4 pt-4 pb-3 ${band}`}>
        <div className="flex items-start justify-between gap-2">
          <h3 id={`site-${site.id}`} className="font-medium text-ink">
            {site.name}
          </h3>
          {!site.inSeason && (
            <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-sm text-muted">
              {t.home.offSeason}
            </span>
          )}
        </div>
        <p
          className={`mt-1 flex items-center gap-2 text-title font-bold tracking-wide uppercase ${word}`}
        >
          <Icon size={26} strokeWidth={2} aria-hidden />
          {label}
        </p>
      </div>

      <div className="flex-1 px-4 pt-5 pb-3">
        {att ? (
          <WaveGauge models={att.models} thresholdM={site.thresholdM} />
        ) : (
          <p className="text-sm text-muted">
            {site.announcement
              ? `${t.home.committed}. ${t.home.expectedAt(fmtTime(site.announcement.attestAt))}.`
              : site.enabled
                ? `${t.home.noCommitment}. ${t.home.expectedAt(attestTime)}.`
                : t.home.notFollowed}
          </p>
        )}
      </div>

      {att && (
        <footer className="flex items-center justify-between gap-2 border-t border-line pl-4 text-sm">
          <span className="text-muted">{t.home.attestedAt(fmtTime(att.createdAt))}</span>
          <Link
            href={verifyHref(att.eventId)}
            className="inline-flex min-h-11 items-center gap-1 px-4 font-medium text-ocean hover:underline"
          >
            {t.home.verify}
            <ChevronRight {...ICON} size={16} />
          </Link>
        </footer>
      )}
    </article>
  );
}
