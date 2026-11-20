import { Sparkles } from 'lucide-react';
import { useI18n } from '../i18n';
import type { BulletinResponse } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useApi } from '../lib/useApi';

/**
 * The day's sea bulletin (docs/BRIEF.md §11): written by a model from the signed attestations, or
 * by a template. Says which, and links the signed Nostr note. Renders nothing until there is one.
 */
export function SeaBulletin() {
  const { t, lang } = useI18n();
  const res = useApi<BulletinResponse>('/api/bulletin', 5 * 60_000);
  const b = res.data?.bulletin;
  if (!b) return null;
  return (
    <section aria-labelledby="bulletin" className="mt-10 max-w-3xl">
      <h2 id="bulletin" className="text-lg font-semibold text-ink">
        {t.home.bulletinTitle(fmtDate(b.date, lang, 'long'))}
      </h2>
      <p className="mt-3 border-l-4 border-ocean pl-4 whitespace-pre-line text-ink">{b.text}</p>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span className="inline-flex items-center gap-1.5">
          {b.source === 'ai' && <Sparkles size={16} strokeWidth={1.75} aria-hidden />}
          {b.source === 'ai' ? t.home.bulletinAi(b.model ?? '') : t.home.bulletinTemplate}
        </span>
        {b.nostrId && b.publishedAt && (
          <a
            href={`https://njump.me/${b.nostrId}`}
            className="text-ocean underline underline-offset-4"
            rel="noopener noreferrer"
            target="_blank"
          >
            {t.home.bulletinNostr}
          </a>
        )}
      </p>
    </section>
  );
}
