import { CheckCircle2, CircleMinus, Loader2, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { ICON } from './ui';

export type CheckListState = 'running' | 'ok' | 'fail' | 'skip';

export interface CheckListItem {
  id: string;
  label: string;
  state: CheckListState;
  detail?: ReactNode;
  /** Technical name, shown as a tooltip and to screen readers. */
  tech?: string;
}

const LOOK: Record<CheckListState, { Icon: typeof CheckCircle2; cls: string }> = {
  running: { Icon: Loader2, cls: 'text-muted animate-spin motion-reduce:animate-none' },
  ok: { Icon: CheckCircle2, cls: 'text-calm' },
  fail: { Icon: XCircle, cls: 'text-danger' },
  skip: { Icon: CircleMinus, cls: 'text-muted' },
};

export function CheckList({ items, label }: { items: CheckListItem[]; label: string }) {
  return (
    <ol aria-label={label} aria-live="polite" className="divide-y divide-line">
      {items.map((c) => {
        const { Icon, cls } = LOOK[c.state];
        return (
          <li key={c.id} className="flex gap-3 py-3" data-state={c.state} data-check={c.id}>
            <span className={`mt-0.5 ${cls}`}>
              <Icon {...ICON} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">
                {c.label}
                <span className="sr-only">
                  {' '}
                  ({c.state}
                  {c.tech ? `, ${c.tech}` : ''})
                </span>
              </p>
              {c.tech && (
                <p className="mt-0.5 font-mono text-[13px] text-muted" aria-hidden>
                  {c.tech}
                </p>
              )}
              {c.detail && <div className="mt-1 text-sm break-words text-muted">{c.detail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
