import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Lang } from '../lib/format';
import { readPref, writePref } from '../lib/storage';
import en from './en';
import fr, { type Messages } from './fr';

const MESSAGES: Record<Lang, Messages> = { fr, en };

interface I18n {
  lang: Lang;
  t: Messages;
  setLang: (l: Lang) => void;
}

const Ctx = createContext<I18n>({ lang: 'fr', t: fr, setLang: () => {} });

function initialLang(): Lang {
  const saved = readPref('ndox.lang');
  return saved === 'en' || saved === 'fr' ? saved : 'fr';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    writePref('ndox.lang', l);
  }, []);
  const value = useMemo(() => ({ lang, t: MESSAGES[lang], setLang }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
