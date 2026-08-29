import { z } from 'zod';

// Tenant wallet & metered WhatsApp billing (docs/wallet-billing-plan.md).
//
// Money is integer MICRO-USD everywhere (1 USD = 1,000,000 µ$). The DB stores it
// as BigInt; realistic balances (< $9B) fit safely in a JS number, so DTOs and
// API responses use `number` micros (converted from BigInt at the serializer).

export const MICROS_PER_USD = 1_000_000;
export const MIN_PRICE_MICROS = 37_500; // $0.0375 floor (Meta reference cost)
export const DEFAULT_PRICE_MICROS = 80_000; // $0.08 default per-message price
export const DEFAULT_META_COST_MICROS = 37_500;

export const usdToMicros = (usd: number): number => Math.round(usd * MICROS_PER_USD);
export const microsToUsd = (micros: number): number => micros / MICROS_PER_USD;

/** Format micro-USD as a plain dollar string, e.g. 80000 → "0.08". */
export function formatMicrosUsd(micros: number, dp = 2): string {
  return (micros / MICROS_PER_USD).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

export const WALLET_LEDGER_KINDS = ['topup', 'adjust', 'hold', 'settle', 'release'] as const;
export type WalletLedgerKind = (typeof WALLET_LEDGER_KINDS)[number];

// ---------- Admin request bodies (amounts entered in dollars) ----------

export const walletSetPriceBodySchema = z.object({
  priceUsd: z.number().min(0.0375).max(100),
});
export type WalletSetPriceBody = z.infer<typeof walletSetPriceBodySchema>;

export const walletTopUpBodySchema = z.object({
  amountUsd: z.number().positive().max(1_000_000),
  note: z.string().max(500).optional(),
});
export type WalletTopUpBody = z.infer<typeof walletTopUpBodySchema>;

export const walletAdjustBodySchema = z.object({
  // Signed: positive credits, negative debits (clamped so balance never < 0).
  amountUsd: z.number().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, 'Amount cannot be zero'),
  note: z.string().max(500).optional(),
});
export type WalletAdjustBody = z.infer<typeof walletAdjustBodySchema>;

export const walletThresholdBodySchema = z.object({
  lowBalanceUsd: z.number().min(0).max(1_000_000),
});

// ---------- Quote (pre-send affordability guard) ----------

export interface WalletQuote {
  metered: boolean; // false = unmetered tenant (no wallet/price) → always ok
  unitPriceMicros: number;
  totalMicros: number; // count × unitPrice
  availableMicros: number;
  maxAffordable: number; // floor(available / price)
  removeCount: number; // max(0, count − maxAffordable)
  ok: boolean; // metered ? available ≥ total : true
}
