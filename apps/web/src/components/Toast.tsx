import { CheckCircle2, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ICON } from './ui';

interface ToastItem {
  id: number;
  tone: 'ok' | 'error';
  text: string;
}

const Ctx = createContext<(text: string, tone?: ToastItem['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (text: string, tone: ToastItem['tone'] = 'ok') => {
      const id = next.current++;
      setItems((xs) => [...xs.slice(-2), { id, tone, text }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );
  return (
    <Ctx.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {items.map((x) => (
          <div
            key={x.id}
            role={x.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-card"
          >
            <span className={x.tone === 'ok' ? 'text-calm' : 'text-danger'}>
              {x.tone === 'ok' ? <CheckCircle2 {...ICON} /> : <XCircle {...ICON} />}
            </span>
            <p className="min-w-0 flex-1 text-sm text-ink">{x.text}</p>
            <button
              type="button"
              onClick={() => dismiss(x.id)}
              className="-m-2 p-2 text-muted hover:text-ink"
              aria-label="OK"
            >
              <X size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
