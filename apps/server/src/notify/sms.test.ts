import { describe, expect, it } from 'vitest';
import { AfricasTalkingSms, fcfaText, gsmSafe, payoutSms, SmsError } from './sms.js';

const GSM7 = /^[A-Za-z0-9 \n@£$¥!"#%&'()*+,\-./:;<=>?_]*$/;

describe('payout SMS', () => {
  it('matches the brief’s template, in plain GSM-7, under 160 characters', () => {
    const text = payoutSms({
      siteName: 'Kayar',
      waveM: 2.8,
      amountFcfa: 2000,
      code: 'K7Q2MD',
      test: false,
    });
    expect(text).toBe(
      "NDOX Kayar: mer dangereuse aujourd'hui (houle 2,8 m). 2 000 FCFA envoyes. Restez a terre. Code: K7Q2MD",
    );
    expect(text).toMatch(GSM7);
  });

  it('drops accents and the parenthesis of long site names, and says TEST for test money', () => {
    const text = payoutSms({
      siteName: 'Soumbédioune (Dakar)',
      waveM: null,
      amountFcfa: 12_500,
      code: 'D23456',
      test: true,
    });
    expect(text).toBe(
      "NDOX Soumbedioune: mer dangereuse aujourd'hui. 12 500 FCFA (TEST) envoyes. Restez a terre. Code: D23456",
    );
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toMatch(GSM7);
    expect(gsmSafe('Saint-Louis (Guet Ndar) — l’été')).toBe("Saint-Louis (Guet Ndar)  l'ete");
    expect(fcfaText(1_234_567)).toBe('1 234 567');
  });
});

describe("Africa's Talking SMS", () => {
  it('posts to the sandbox with the API key header and returns the message id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sms = new AfricasTalkingSms({
      username: 'sandbox',
      apiKey: 'atsk_test',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({
          SMSMessageData: {
            Message: 'Sent to 1/1',
            Recipients: [{ statusCode: 101, status: 'Success', messageId: 'ATXid_1' }],
          },
        });
      }) as typeof fetch,
    });
    expect(sms.simulated).toBe(true);
    expect(await sms.send('+221771234567', 'Bonjour')).toEqual({
      providerId: 'ATXid_1',
      simulated: true,
    });
    expect(calls[0]!.url).toBe('https://api.sandbox.africastalking.com/version1/messaging');
    expect(calls[0]!.init.headers).toMatchObject({ apiKey: 'atsk_test' });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.init.body as string))).toEqual({
      username: 'sandbox',
      to: '+221771234567',
      message: 'Bonjour',
    });
    expect(new AfricasTalkingSms({ username: 'ndox', apiKey: 'k' }).simulated).toBe(false);
  });

  it('fails on a refused recipient or an HTTP error, without echoing the number', async () => {
    const answer = (status: number, body: unknown) =>
      new AfricasTalkingSms({
        username: 'sandbox',
        apiKey: 'k',
        fetchImpl: (async () => Response.json(body, { status })) as typeof fetch,
      });
    const refused = await answer(200, {
      SMSMessageData: { Recipients: [{ statusCode: 403, status: 'InvalidPhoneNumber' }] },
    })
      .send('+221771234567', 'x')
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SmsError);
    expect(String(refused)).toContain('InvalidPhoneNumber');
    expect(String(refused)).not.toContain('771234567');
    await expect(answer(401, {}).send('+221771234567', 'x')).rejects.toThrow('answered 401');
    const down = new AfricasTalkingSms({
      username: 'sandbox',
      apiKey: 'k',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(down.send('+221771234567', 'x')).rejects.toThrow('unreachable');
  });
});
