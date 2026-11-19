import { useI18n } from '../i18n';
import type { Outcome } from '../lib/api';

const CLS: Record<Outcome, string> = {
  calme: 'bg-calm-bg text-calm',
  danger: 'bg-danger-bg text-danger',
  indisponible: 'bg-warn-bg text-warn',
};

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const { t } = useI18n();
  return (
    <span className={`rounded-full px-2 py-0.5 text-sm font-semibold ${CLS[outcome]}`}>
      {t.outcome[outcome]}
    </span>
  );
}
