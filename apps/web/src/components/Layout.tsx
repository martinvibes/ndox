import { BarChart3, HandCoins, ShieldCheck, Waves } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useI18n } from '../i18n';
import type { Meta } from '../lib/api';
import type { Lang } from '../lib/format';
import { useApi } from '../lib/useApi';

const REPO = 'https://github.com/martinvibes/ndox';

/** The mark: a pirogue's painted hull stripe riding two swells. */
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5 text-ink">
      <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden>
        <circle cx="15" cy="15" r="15" fill="var(--color-deep)" />
        <path d="M7 12.5h16l-2.2 3.2H9.2z" fill="var(--color-saffron)" />
        <path
          d="M5 19.5c2.5 0 2.5-2.2 5-2.2s2.5 2.2 5 2.2 2.5-2.2 5-2.2 2.5 2.2 5 2.2"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M7 23.5c2.2 0 2.2-1.8 4.4-1.8s2.2 1.8 4.4 1.8 2.2-1.8 4.4-1.8 2.2 1.8 2.8 1.8"
          fill="none"
          stroke="#fff"
          strokeOpacity=".5"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
      <span className="font-display text-[1.45rem] leading-none font-semibold tracking-tight">
        Ndox
      </span>
    </span>
  );
}

export function LangToggle() {
  const { lang, setLang, t } = useI18n();
  const opts: Lang[] = ['fr', 'en'];
  return (
    <div
      role="group"
      aria-label={t.lang.label}
      className="flex rounded-full border border-line bg-surface p-0.5"
    >
      {opts.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={`min-h-9 min-w-11 rounded-full px-2.5 text-sm font-medium ${
            lang === l ? 'bg-deep text-white' : 'text-muted hover:text-ink'
          }`}
        >
          {l}
          <span className="sr-only"> ({t.lang[l]})</span>
        </button>
      ))}
    </div>
  );
}

function NavLink({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  const [loc] = useLocation();
  const active = href === '/' ? loc === '/' : loc === href || loc.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-xs font-medium sm:min-h-10 sm:flex-none sm:flex-row sm:gap-1.5 sm:px-3.5 sm:text-sm ${
        active ? 'bg-ocean-50 text-deep' : 'text-muted hover:text-ink'
      }`}
    >
      {icon}
      {children}
    </Link>
  );
}

const I = { size: 18, strokeWidth: 1.75, 'aria-hidden': true } as const;

export function PublicLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [loc] = useLocation();
  // the home page tells the story across the full width; reading pages stay narrow
  const width = loc === '/' ? 'max-w-[1080px]' : 'max-w-[760px]';
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-btn focus:bg-surface focus:px-3 focus:py-2"
      >
        {t.common.skip}
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1080px] flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2.5 sm:px-6">
          <Link href="/" className="-ml-1 rounded-btn p-1" aria-label="Ndox">
            <Wordmark />
          </Link>
          <div className="ml-auto sm:order-last">
            <LangToggle />
          </div>
          <nav
            aria-label="Ndox"
            className="-mx-1 flex w-full gap-1 overflow-x-auto sm:mx-0 sm:w-auto sm:flex-1 sm:justify-center"
          >
            <NavLink href="/" icon={<Waves {...I} />}>
              {t.nav.today}
            </NavLink>
            <NavLink href="/verifier" icon={<ShieldCheck {...I} />}>
              {t.nav.verify}
            </NavLink>
            <NavLink href="/soutenir" icon={<HandCoins {...I} />}>
              {t.nav.sponsor}
            </NavLink>
            <NavLink href="/donnees" icon={<BarChart3 {...I} />}>
              {t.nav.data}
            </NavLink>
          </nav>
        </div>
      </header>
      <main id="main" className={`mx-auto w-full ${width} flex-1 px-4 py-8 sm:px-6 sm:py-14`}>
        {children}
      </main>
      <Footer />
    </div>
  );
}

export function Footer() {
  const { t } = useI18n();
  const meta = useApi<Meta>('/api/meta');
  const m = meta.data;
  const network = !m
    ? null
    : m.walletMode === 'fake'
      ? t.footer.network.simulated
      : m.testFunds
        ? t.footer.network.test
        : t.footer.network.mainnet;
  return (
    <footer className="mt-16 border-t border-line bg-mist">
      <div className="mx-auto grid max-w-[1080px] gap-8 px-4 py-10 sm:grid-cols-[1.4fr_1fr] sm:px-6">
        <div>
          <Wordmark />
          <p className="mt-3 max-w-[40ch] font-display text-lg text-ink">{t.common.tagline}</p>
          {network && (
            <p data-testid="footer-network" className="mt-3 text-sm text-muted">
              {network}
            </p>
          )}
        </div>
        <ul className="grid content-start gap-2 text-sm text-muted">
          <li>
            <a
              className="hover:text-ink hover:underline"
              href={`${REPO}/blob/main/docs/REAL_VS_SIMULATED.md`}
            >
              {t.footer.realVsSim}
            </a>
          </li>
          <li>
            <a className="hover:text-ink hover:underline" href={REPO}>
              {t.footer.source}
            </a>
          </li>
          <li>
            <a className="hover:text-ink hover:underline" href="/e">
              {t.home.ctaCrew}
            </a>
          </li>
          <li>
            <Link className="hover:text-ink hover:underline" href="/conseil">
              {t.nav.council}
            </Link>
          </li>
          <li>{t.footer.data}</li>
        </ul>
      </div>
    </footer>
  );
}
