/**
 * Design-system primitives (docs/BRIEF.md §10.3): Button, Badge, StatTile, EmptyState, ErrorState,
 * Section. Tokens live in index.css; icons are lucide at 20 px, stroke 1.75.
 */
import {
  AlertTriangle,
  FlaskConical,
  History,
  RefreshCw,
  TestTubeDiagonal,
  UserRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react';
import { Link } from 'wouter';
import { useI18n } from '../i18n';
import type { ApiError } from '../lib/api';

export const ICON = { size: 20, strokeWidth: 1.75, 'aria-hidden': true } as const;

const BTN_BASE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-btn px-4 text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const BTN = {
  primary: `${BTN_BASE} bg-ocean text-white hover:bg-[#094d78]`,
  secondary: `${BTN_BASE} border border-line bg-surface text-ink hover:border-ocean hover:text-ocean`,
  ghost: `${BTN_BASE} text-ocean hover:bg-ocean-50`,
  danger: `${BTN_BASE} border border-danger/40 bg-surface text-danger hover:bg-danger-bg`,
} as const;
export type ButtonVariant = keyof typeof BTN;

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={`${BTN[variant]} ${className}`} {...rest} />;
}

export function LinkButton({
  href,
  variant = 'primary',
  className = '',
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`${BTN[variant]} ${className}`}>
      {children}
    </Link>
  );
}

export type BadgeKind = 'simulated' | 'test' | 'replay' | 'demo' | 'forecast';
const BADGE: Record<BadgeKind, { cls: string; Icon: LucideIcon | null }> = {
  simulated: { cls: 'bg-warn-bg text-warn', Icon: FlaskConical },
  test: { cls: 'bg-warn-bg text-warn', Icon: TestTubeDiagonal },
  replay: { cls: 'bg-ocean-50 text-ocean', Icon: History },
  demo: { cls: 'border border-line bg-bg text-muted', Icon: UserRound },
  forecast: { cls: 'border border-line bg-surface text-muted', Icon: null },
};

/** Honesty badges: anything simulated, replayed or demo is labelled where it is shown. */
export function Badge({ kind, className = '' }: { kind: BadgeKind; className?: string }) {
  const { t } = useI18n();
  const label = t.badge[kind];
  const hint = t.badge[`${kind}Hint`];
  const { cls, Icon } = BADGE[kind];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-sm font-medium ${cls} ${className}`}
      title={hint}
    >
      {Icon && <Icon size={14} strokeWidth={2} aria-hidden />}
      {label}
      <span className="sr-only">: {hint}</span>
    </span>
  );
}

/** Where money is shown: "Simulé" (FakeWallet), "Fonds de test" (test network), or nothing. */
export function MoneyBadge({
  simulated,
  testFunds,
  className,
}: {
  simulated?: boolean | undefined;
  testFunds?: boolean | undefined;
  className?: string;
}) {
  if (simulated) return <Badge kind="simulated" className={className} />;
  if (testFunds) return <Badge kind="test" className={className} />;
  return null;
}

export function StatTile({
  label,
  value,
  sub,
  tone = 'ink',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'ink' | 'danger' | 'calm' | 'warn';
}) {
  const toneCls = { ink: 'text-ink', danger: 'text-danger', calm: 'text-calm', warn: 'text-warn' }[
    tone
  ];
  return (
    <div className="min-w-0 bg-surface px-4 py-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`tabular mt-1 text-lg font-semibold ${toneCls}`}>{value}</dd>
      {sub && <dd className="mt-0.5 text-sm text-muted">{sub}</dd>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: ComponentType<typeof ICON>;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-line px-6 py-10 text-center">
      <Icon {...ICON} />
      <p className="mt-3 font-medium text-ink">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-[46ch] text-sm text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error?: ApiError; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-card border border-warn/30 bg-warn-bg px-4 py-3 text-warn"
    >
      <AlertTriangle {...ICON} />
      <p className="min-w-0 flex-1 text-sm">
        {error?.code === 'network' ? t.common.offline : t.common.loadError}
      </p>
      <Button variant="secondary" onClick={onRetry} className="min-h-9 text-sm">
        <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
        {t.common.retry}
      </Button>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-card bg-line/60 ${className}`} aria-hidden />;
}

export function PageTitle({ children, lead }: { children: ReactNode; lead?: ReactNode }) {
  return (
    <header className="mb-8">
      <h1 className="text-title font-semibold tracking-tight text-ink sm:text-display">
        {children}
      </h1>
      {lead && <p className="mt-3 max-w-[62ch] text-muted">{lead}</p>}
    </header>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-semibold text-ink">{children}</h2>
      {aside}
    </div>
  );
}
