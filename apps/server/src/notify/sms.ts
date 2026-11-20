/**
 * SMS to covered crews (docs/BRIEF.md §8): a console notifier by default, Africa's Talking (sandbox
 * or live) when AT_API_KEY is set. Phone numbers never reach a log line; the message text holds no
 * PII beyond what the recipient already knows (their site, the payout, their status code).
 */
export interface SmsResult {
  /** Provider message id (delivery reports refer to it); null for the console notifier. */
  providerId: string | null;
  /** True when no SMS actually left the server. */
  simulated: boolean;
}

export interface Notifier {
  readonly kind: 'console' | 'africastalking';
  readonly simulated: boolean;
  send(to: string, message: string): Promise<SmsResult>;
}

export class SmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsError';
  }
}

/** Last two digits only: enough to tell two test phones apart in a log, never a number. */
export function phoneHint(phone: string): string {
  return `••${phone.slice(-2)}`;
}

export class ConsoleNotifier implements Notifier {
  readonly kind = 'console' as const;
  readonly simulated = true;
  readonly sent: { to: string; message: string }[] = [];

  constructor(private readonly log: { info(msg: string, meta?: object): void }) {}

  async send(to: string, message: string): Promise<SmsResult> {
    this.sent.push({ to, message });
    this.log.info('sms (console)', { to: phoneHint(to), message });
    return { providerId: null, simulated: true };
  }
}

/** Africa's Talking SMS: https://developers.africastalking.com/docs/sms/sending/bulk */
export class AfricasTalkingSms implements Notifier {
  readonly kind = 'africastalking' as const;
  readonly simulated: boolean;
  private readonly endpoint: string;

  constructor(
    private readonly o: {
      username: string;
      apiKey: string;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    // the sandbox delivers to the AT simulator only: nothing reaches a real phone
    this.simulated = o.username === 'sandbox';
    this.endpoint = this.simulated
      ? 'https://api.sandbox.africastalking.com/version1/messaging'
      : 'https://api.africastalking.com/version1/messaging';
  }

  async send(to: string, message: string): Promise<SmsResult> {
    const res = await (this.o.fetchImpl ?? fetch)(this.endpoint, {
      method: 'POST',
      headers: {
        apiKey: this.o.apiKey,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ username: this.o.username, to, message }).toString(),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    }).catch(() => {
      throw new SmsError('SMS provider unreachable');
    });
    if (!res.ok) throw new SmsError(`SMS provider answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as {
      SMSMessageData?: {
        Recipients?: { statusCode?: number; status?: string; messageId?: string }[];
      };
    } | null;
    const r = body?.SMSMessageData?.Recipients?.[0];
    // 100 processed, 101 sent, 102 queued
    if (!r || !r.statusCode || r.statusCode < 100 || r.statusCode > 102)
      throw new SmsError(`SMS refused: ${r?.status ?? 'no recipient in answer'}`.slice(0, 120));
    return { providerId: r.messageId ?? null, simulated: this.simulated };
  }
}

/** GSM 03.38 friendly: no accents (a single "é" would switch the SMS to UCS-2, 70 chars). */
export function gsmSafe(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[^\x20-\x7e\n]/g, '');
}

/** "2 000" — the thin space French uses would not survive GSM-7. */
export function fcfaText(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** "2,8" */
export function metresText(m: number): string {
  return m.toFixed(1).replace('.', ',');
}

/**
 * The payout SMS (≤ 160 GSM-7 characters):
 * `NDOX Kayar: mer dangereuse aujourd'hui (houle 2,8 m). 2 000 FCFA envoyes. Restez a terre. Code: K7Q2MD`
 */
export function payoutSms(o: {
  siteName: string;
  waveM: number | null;
  amountFcfa: number;
  code: string;
  /** Test sats or simulated: say so, the crew must not think money arrived. */
  test: boolean;
}): string {
  const site = gsmSafe(o.siteName.replace(/\s*\(.*\)\s*$/, ''));
  const wave = o.waveM !== null ? ` (houle ${metresText(o.waveM)} m)` : '';
  const sent = o.test ? `${fcfaText(o.amountFcfa)} FCFA (TEST)` : `${fcfaText(o.amountFcfa)} FCFA`;
  const text = `NDOX ${site}: mer dangereuse aujourd'hui${wave}. ${sent} envoyes. Restez a terre. Code: ${o.code}`;
  return gsmSafe(text).slice(0, 160);
}
