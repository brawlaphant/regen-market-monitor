/**
 * Hyperliquid Trading Strategies
 *
 * - Funding Rate Capture: short assets with positive funding (longs pay shorts),
 *   long assets with negative funding (shorts pay longs)
 * - Momentum: ride strong 24h moves in liquid assets
 *
 * Requires `hyperliquid` npm package for SDK access.
 */

import type { Logger } from "../../logger.js";
import type { HyperliquidSignal, HyperliquidConfig } from "./types.js";

/**
 * Scan funding rates across all Hyperliquid perpetuals.
 * Returns signals for the top 5 extreme funding rates.
 */
export async function scanFunding(
  sdk: { info: { perpetuals: { getMetaAndAssetCtxs: () => Promise<unknown[]> } } },
  config: HyperliquidConfig,
  logger: Logger
): Promise<HyperliquidSignal[]> {
  const signals: HyperliquidSignal[] = [];

  const meta = await sdk.info.perpetuals.getMetaAndAssetCtxs();
  if (!meta || !Array.isArray(meta) || meta.length < 2) return signals;

  const universe = (meta[0] as Record<string, unknown>)?.universe as Array<Record<string, unknown>> || [];
  const contexts = meta[1] as Array<Record<string, unknown>> || [];

  for (let i = 0; i < universe.length && i < contexts.length; i++) {
    const asset = universe[i];
    const ctx = contexts[i];
    if (!asset || !ctx) continue;

    const coin = asset.name as string;
    const funding = parseFloat(String(ctx.funding || "0"));
    const markPx = parseFloat(String(ctx.markPx || "0"));
    const volume24h = parseFloat(String(ctx.dayNtlVlm || "0"));

    if (markPx <= 0 || volume24h < config.minVolume24h) continue;

    const annualized = funding * 24 * 365;
    if (Math.abs(annualized) < config.fundingThreshold) continue;

    const direction = funding > 0 ? ("short" as const) : ("long" as const);
    const size = Math.min(config.maxPosition, config.dailyCap * 0.3);

    signals.push({
      coin,
      strategy: "funding",
      direction,
      entry: markPx,
      size_usd: size,
      leverage: Math.min(3, config.maxLeverage),
      funding_rate: funding,
      funding_annualized: annualized,
      rationale: `${coin} funding ${(annualized * 100).toFixed(1)}% annualized — ${direction} to collect`,
    });
  }

  signals.sort((a, b) => Math.abs(b.funding_annualized || 0) - Math.abs(a.funding_annualized || 0));
  logger.debug({ count: signals.length }, "Hyperliquid funding signals");
  return signals.slice(0, 5);
}

/**
 * Scan 24h momentum across all Hyperliquid perpetuals.
 * Returns signals for the top 5 movers above the threshold.
 */
export async function scanMomentum(
  sdk: { info: { perpetuals: { getMetaAndAssetCtxs: () => Promise<unknown[]> } } },
  config: HyperliquidConfig,
  logger: Logger
): Promise<HyperliquidSignal[]> {
  const signals: HyperliquidSignal[] = [];

  const meta = await sdk.info.perpetuals.getMetaAndAssetCtxs();
  if (!meta || !Array.isArray(meta) || meta.length < 2) return signals;

  const universe = (meta[0] as Record<string, unknown>)?.universe as Array<Record<string, unknown>> || [];
  const contexts = meta[1] as Array<Record<string, unknown>> || [];

  for (let i = 0; i < universe.length && i < contexts.length; i++) {
    const asset = universe[i];
    const ctx = contexts[i];
    if (!asset || !ctx) continue;

    const coin = asset.name as string;
    const markPx = parseFloat(String(ctx.markPx || "0"));
    const prevDayPx = parseFloat(String(ctx.prevDayPx || "0"));
    const volume24h = parseFloat(String(ctx.dayNtlVlm || "0"));

    if (markPx <= 0 || prevDayPx <= 0 || volume24h < config.minVolume24h) continue;

    const change = (markPx - prevDayPx) / prevDayPx;
    if (Math.abs(change) < config.momentumThreshold) continue;

    const direction = change > 0 ? ("long" as const) : ("short" as const);
    const size = Math.min(config.maxPosition, config.dailyCap * 0.25);

    signals.push({
      coin,
      strategy: "momentum",
      direction,
      entry: markPx,
      size_usd: size,
      leverage: Math.min(2, config.maxLeverage),
      momentum_pct: change,
      rationale: `${coin} ${(change * 100).toFixed(1)}% move in 24h — ${direction} momentum`,
    });
  }

  signals.sort((a, b) => Math.abs(b.momentum_pct || 0) - Math.abs(a.momentum_pct || 0));
  logger.debug({ count: signals.length }, "Hyperliquid momentum signals");
  return signals.slice(0, 5);
}
