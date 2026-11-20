import { BarChart3, HandCoins, ShieldCheck, Waves } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useI18n } from '../i18n';
import type { Meta } from '../lib/api';
import type { Lang } from '../lib/format';
import { useApi } from '../lib/useApi';

const REPO = 'https://github.com/martinvibes/ndox';

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-lg font-bold tracking-tight text-ink">
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <rect width="28" height="28" rx="8" fill="var(--color-ocean)" />
        <path
          d="M5 16c2.2 0 2.2-2.5 4.5-2.5S11.7 16 14 16s2.2-2.5 4.5-2.5S20.8 16 23 16"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M5 20.5c2.2 0 2.2-2.5 4.5-2.5s2.2 2.5 4.5 2.5 2.2-2.5 4.5-2.5 2.3 2.5 4.5 2.5"
          fill="none"
          stroke="#fff"
          strokeOpacity=".55"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      Ndox
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
      className="flex rounded-btn border border-line p-0.5"
    >
      {opts.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={`min-h-9 min-w-11 rounded-[6px] px-2 text-sm font-medium uppercase ${
            lang === l ? 'bg-ink text-white' : 'text-muted hover:text-ink'
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
      className={`flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-btn px-1 text-xs font-medium sm:min-h-11 sm:flex-none sm:flex-row sm:gap-1.5 sm:px-3 sm:text-sm ${
        active ? 'bg-ocean-50 text-ocean' : 'text-muted hover:text-ink'
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
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-btn focus:bg-surface focus:px-3 focus:py-2"
      >
        {t.common.skip}
      </a>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[720px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <Link href="/" className="-ml-1 rounded-btn p-1" aria-label="Ndox">
            <Wordmark />
          </Link>
          <div className="ml-auto sm:order-last">
            <LangToggle />
          </div>
          <nav
            aria-label="Ndox"
            className="-mx-1 flex w-full gap-1 overflow-x-auto sm:mx-0 sm:w-auto sm:flex-1"
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
      <main id="main" className="mx-auto w-full max-w-[720px] flex-1 px-4 py-8 sm:py-12">
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
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-[720px] flex-col gap-2 px-4 py-6 text-sm text-muted sm:flex-row sm:flex-wrap sm:gap-x-6">
        <span className="font-medium text-ink">{t.common.tagline}</span>
        <a
          className="hover:text-ink hover:underline"
          href={`${REPO}/blob/main/docs/REAL_VS_SIMULATED.md`}
        >
          {t.footer.realVsSim}
        </a>
        <a className="hover:text-ink hover:underline" href={REPO}>
          {t.footer.source}
        </a>
        <Link className="hover:text-ink hover:underline" href="/conseil">
          {t.nav.council}
        </Link>
        <span>{t.footer.data}</span>
        {network && <span data-testid="footer-network">{network}</span>}
      </div>
    </footer>
  );
}
