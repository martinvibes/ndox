import { MessageCircleQuestion } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { api, ApiError, type Explanation, type RulesResponse } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Button, ICON } from './ui';

/**
 * "Ask about the rules" (docs/BRIEF.md §11): the model answers only from the rules the server
 * applies, or says it does not know. Hidden when the server has no model.
 */
export function RulesExplainer() {
  const { t, lang } = useI18n();
  const rules = useApi<RulesResponse>('/api/rules');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Explanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const model = rules.data?.explainer;
  if (!model) return null;

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.send<Explanation>('POST', '/api/explain', { question: q, lang }));
    } catch (err) {
      setAnswer(null);
      setError(
        err instanceof ApiError && err.code === 'rate_limited'
          ? t.home.explainRateLimited
          : t.home.explainError,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="explain" className="mt-14 max-w-3xl">
      <h2 id="explain" className="text-lg font-semibold text-ink">
        {t.home.explainTitle}
      </h2>
      <p className="mt-1 max-w-[60ch] text-muted">{t.home.explainLead}</p>
      <form onSubmit={(e) => void ask(e)} className="mt-4 flex flex-col gap-3 sm:flex-row">
        <label htmlFor={inputId} className="sr-only">
          {t.home.explainTitle}
        </label>
        <input
          id={inputId}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={300}
          placeholder={t.home.explainPlaceholder}
          className="min-h-11 flex-1 rounded-btn border border-line bg-surface px-3 text-ink placeholder:text-muted focus:border-ocean focus:outline-none"
        />
        <Button type="submit" disabled={busy || question.trim().length < 3}>
          <MessageCircleQuestion {...ICON} />
          {busy ? t.home.explainAsking : t.home.explainAsk}
        </Button>
      </form>
      <div aria-live="polite" className="mt-4">
        {answer && (
          <div className="rounded-card border border-line bg-surface p-4">
            <p className={answer.known ? 'text-ink' : 'text-muted'}>{answer.answer}</p>
            <p className="mt-2 text-sm text-muted">{t.home.explainBy(answer.model)}</p>
          </div>
        )}
        {error && <p className="text-danger">{error}</p>}
      </div>
    </section>
  );
}
