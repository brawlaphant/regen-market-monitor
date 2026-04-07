/**
 * Base EcoWealth Strategies
 *
 * Scan parent wallet ledger and generate trading signals.
 * Strategies:
 *   - litcoin_accumulation: parent LITCOIN stack growing
 *   - ecowealth_fdv: ECOWEALTH token pump progress
 *   - regen_accumulation: REGEN buys from profits
 *   - yield_reinvestment: staking yield flowing to operations
 */

import type { BaseEcowealthConfig, BaseEcowealthSignal } from "./types.js";

interface ParentLedgerResponse {
  trades: Array<{
    timestamp: string;
    symbol: string;
    side: "buy" | "sell";
    size: number;
    price: number;
    realized_pnl?: number;
    pnl?: number;
  }>;
  prices: Record<string, number>;
  yields: Record<string, number>;
  gas_spent_24h: number;
  pnl_24h: number;
  metadata: {
    wallet: string;
    last_trade: string | null;
    total_trades_lifetime: number;
    updatedAt: string;
  };
}

export async function scanParentLedger(
  config: BaseEcowealthConfig
): Promise<BaseEcowealthSignal[]> {
  const signals: BaseEcowealthSignal[] = [];

  try {
    const url = new URL("/vealth/api/parent/ledger", config.parentLedgerUrl);
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(5_000) });

    if (!resp.ok) {
      console.warn(`[base-ecowealth] parent ledger returned ${resp.status}`);
      return signals;
    }

    const ledger = (await resp.json()) as ParentLedgerResponse;

    // Extract prices
    const litPrice = ledger.prices.LITCOIN || 0;
    const wethPrice = ledger.prices.WETH || 0;
    const regenPrice = ledger.prices.REGEN || 0;
    const ecoPrice = ledger.prices.ECOWEALTH || 0;

    // ── Strategy 1: LITCOIN Accumulation ──────────────────────────────

    if (ledger.yields.litcoin_mined_today > 0) {
      const confidence = Math.min(1.0, 0.5 + ledger.pnl_24h / 1000); // 50% base + profit confidence
      signals.push({
        market: "parent-base",
        asset: "LITCOIN/WETH",
        strategy: "litcoin_accumulation",
        direction: ledger.pnl_24h > 0 ? "buy" : "hold",
        entry: litPrice,
        size_usd: ledger.yields.litcoin_mined_today * litPrice,
        leverage: 1,
        metrics: {
          pnl_24h: ledger.pnl_24h,
          gas_spent_24h: ledger.gas_spent_24h,
          litcoin_mined_today: ledger.yields.litcoin_mined_today,
          staking_yield_24h: ledger.yields.staking_yield_24h || 0,
          price_usd: litPrice,
          confidence: Math.min(1.0, confidence),
        },
        timestamp: new Date().toISOString(),
      });
    }

    // ── Strategy 2: ECOWEALTH FDV Pump ───────────────────────────────

    if (ecoPrice > 0) {
      const ecoSellSignals = ledger.trades.filter(
        (t) => t.symbol === "ECOWEALTH" && t.side === "buy"
      );
      const confidence = Math.min(0.9, 0.3 + ecoSellSignals.length * 0.1); // 30% + activity confidence
      signals.push({
        market: "parent-base",
        asset: "ECOWEALTH/WETH",
        strategy: "ecowealth_fdv",
        direction: ecoSellSignals.length > 0 ? "buy" : "hold",
        entry: ecoPrice,
        size_usd: ecoSellSignals.length > 0 ? 100 : 0, // $100 signal if buys observed
        leverage: 1,
        metrics: {
          pnl_24h: ledger.pnl_24h,
          gas_spent_24h: ledger.gas_spent_24h,
          litcoin_mined_today: ledger.yields.litcoin_mined_today,
          staking_yield_24h: ledger.yields.staking_yield_24h || 0,
          price_usd: ecoPrice,
          confidence,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // ── Strategy 3: REGEN Accumulation ───────────────────────────────

    if (regenPrice > 0 && ledger.pnl_24h > 500) {
      // Only signal REGEN buy if 24h P&L > $500 (profitable day)
      const confidence = Math.min(1.0, 0.6 + (ledger.pnl_24h / 5000) * 0.4); // 60% + profit confidence
      signals.push({
        market: "parent-base",
        asset: "REGEN/WETH",
        strategy: "regen_accumulation",
        direction: "buy",
        entry: regenPrice,
        size_usd: Math.min(1000, ledger.pnl_24h * 0.2), // 20% of daily P&L, max $1K
        leverage: 1,
        metrics: {
          pnl_24h: ledger.pnl_24h,
          gas_spent_24h: ledger.gas_spent_24h,
          litcoin_mined_today: ledger.yields.litcoin_mined_today,
          staking_yield_24h: ledger.yields.staking_yield_24h || 0,
          price_usd: regenPrice,
          confidence,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // ── Strategy 4: Yield Reinvestment ──────────────────────────────

    if (ledger.yields.staking_yield_24h > 0) {
      const confidence = Math.min(0.95, 0.7 + (ledger.yields.staking_yield_24h / 1000) * 0.25);
      signals.push({
        market: "parent-base",
        asset: "LITCOIN/staking",
        strategy: "yield_reinvestment",
        direction: "buy", // reinvest yield
        entry: litPrice,
        size_usd: ledger.yields.staking_yield_24h * litPrice,
        leverage: 1,
        metrics: {
          pnl_24h: ledger.pnl_24h,
          gas_spent_24h: ledger.gas_spent_24h,
          litcoin_mined_today: ledger.yields.litcoin_mined_today,
          staking_yield_24h: ledger.yields.staking_yield_24h,
          price_usd: litPrice,
          confidence,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Filter by confidence threshold
    return signals.filter((s) => s.metrics.confidence >= config.confidenceThreshold);
  } catch (err) {
    console.error("[base-ecowealth] scanParentLedger error", err);
    return signals;
  }
}

// Export for orchestrator
export type SdkLike = ReturnType<typeof scanParentLedger>;
