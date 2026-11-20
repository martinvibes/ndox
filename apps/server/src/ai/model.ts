/**
 * The language model behind the sea bulletin and the rules explainer (docs/BRIEF.md §11).
 * Anthropic (ANTHROPIC_API_KEY, model ANTHROPIC_MODEL) first; OpenAI (OPENAI_API_KEY) as an
 * alternative; none at all is fine: both features then fall back to templates.
 * The model's text is shown to people and posted on Nostr; it never reaches the payout engine.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface TextModel {
  readonly provider: 'anthropic' | 'openai';
  readonly model: string;
  /** One system prompt, one user message, plain text back. */
  complete(o: { system: string; user: string; maxTokens: number }): Promise<string>;
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

export class AnthropicModel implements TextModel {
  readonly provider = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    o: { apiKey?: string; client?: Anthropic; timeoutMs?: number } = {},
  ) {
    this.client =
      o.client ??
      new Anthropic({ apiKey: o.apiKey, timeout: o.timeoutMs ?? 30_000, maxRetries: 1 });
  }

  async complete(o: { system: string; user: string; maxTokens: number }): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: o.maxTokens,
      system: o.system,
      messages: [{ role: 'user', content: o.user }],
      // short, factual writing from given data: little thinking needed
      output_config: { effort: 'low' },
    });
    if (res.stop_reason === 'refusal') throw new ModelError('model declined');
    if (res.stop_reason === 'max_tokens') throw new ModelError('answer cut off');
    const text = res.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim();
    if (!text) throw new ModelError('empty answer');
    return text;
  }
}

/** OpenAI Chat Completions over fetch (no extra dependency). */
export class OpenAiModel implements TextModel {
  readonly provider = 'openai' as const;

  constructor(
    readonly model: string,
    private readonly o: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  ) {}

  async complete(o: { system: string; user: string; maxTokens: number }): Promise<string> {
    const res = await (this.o.fetchImpl ?? fetch)('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: o.maxTokens,
        messages: [
          { role: 'system', content: o.system },
          { role: 'user', content: o.user },
        ],
      }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
    }).catch(() => {
      throw new ModelError('model unreachable');
    });
    if (!res.ok) throw new ModelError(`model answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string | null; refusal?: string | null } }[];
    } | null;
    const msg = body?.choices?.[0]?.message;
    if (msg?.refusal) throw new ModelError('model declined');
    const text = msg?.content?.trim();
    if (!text) throw new ModelError('empty answer');
    return text;
  }
}

export function createTextModel(c: {
  anthropic: { apiKey: string | undefined; model: string };
  openai: { apiKey: string | undefined; model: string };
}): TextModel | null {
  if (c.anthropic.apiKey)
    return new AnthropicModel(c.anthropic.model, { apiKey: c.anthropic.apiKey });
  if (c.openai.apiKey) return new OpenAiModel(c.openai.model, { apiKey: c.openai.apiKey });
  return null;
}
