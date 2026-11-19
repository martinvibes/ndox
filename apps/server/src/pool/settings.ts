/**
 * Policy rules (docs/BRIEF.md §7.1): defaults come from the environment, the council can change
 * them from the dashboard (stored in the settings table under "policy").
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';

type DbLike = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
import { settings } from '../db/schema.js';

export interface PolicySettings {
  /** Payout per covered crew per danger day (FCFA). */
  payoutFcfa: number;
  waitingHours: number;
  premiumLoading: number;
  dailyPayoutCapSats: number;
  reserveFloorSats: number;
}

export const PolicySettingsPatch = z
  .object({
    payoutFcfa: z.number().int().min(100).max(100_000),
    waitingHours: z
      .number()
      .int()
      .min(0)
      .max(24 * 30),
    premiumLoading: z.number().min(0).max(5),
    dailyPayoutCapSats: z.number().int().min(0).max(10_000_000),
    reserveFloorSats: z.number().int().min(0).max(100_000_000),
  })
  .partial()
  .strict();

const KEY = 'policy';

export function policyDefaults(c: Config): PolicySettings {
  return {
    payoutFcfa: c.payoutFcfa,
    waitingHours: c.waitingHours,
    premiumLoading: c.premiumLoading,
    dailyPayoutCapSats: c.dailyPayoutCapSats,
    reserveFloorSats: c.reserveFloorSats,
  };
}

export function getPolicySettings(db: DbLike, defaults: PolicySettings): PolicySettings {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  const stored = PolicySettingsPatch.safeParse(row?.value ?? {});
  return { ...defaults, ...(stored.success ? stored.data : {}) };
}

export function updatePolicySettings(
  db: DbLike,
  defaults: PolicySettings,
  patch: unknown,
): PolicySettings {
  const p = PolicySettingsPatch.parse(patch);
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  const current = PolicySettingsPatch.safeParse(row?.value ?? {});
  const value = { ...(current.success ? current.data : {}), ...p };
  db.insert(settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date().toISOString() },
    })
    .run();
  return { ...defaults, ...value };
}
