/**
 * %%VENUE_NAME%% Trading Strategies
 *
 * Each strategy is an async function that:
 *   1. Fetches market data from the venue SDK/API
 *   2. Applies a filter (threshold, volume, etc.)
 *   3. Returns an array of signals
 *
 * Strategies must be pure-ish: they take an SDK handle, config, and logger,
 * and return signals. No side effects, no execution. The orchestrator
 * decides what to do with the signals.
 *
 * Existing patterns to follow:
 *   - gmx/strategies.ts: scanFunding, scanMomentum, scanGmPools
 *   - hyperliquid/strategies.ts: scanFunding, scanMomentum
 *   - polymarket/strategies.ts: runSpray, runWorldview, runContrarian, runCloser
 *
 * Steps to implement:
 *   1. Define a minimal SDK type interface (see SdkLike below)
 *   2. Write one strategy function
 *   3. Test it with a mock SDK (see tests/unit/gmx-strategies.test.ts for the pattern)
 *   4. Add more strategies once the first one works
 */

import type { Logger } from "../../logger.js";
import type { %%VENUE_NAME%%Signal, %%VENUE_NAME%%Config } from "./types.js";

// ─── SDK Type Mirror ────────────────────────────────────────────────────
// Define a minimal interface that matches the shape of the venue's SDK.
// This lets you test strategies without importing the real SDK.
// Only include the methods your strategies actually call.

/**
 * TODO: Replace this with the actual shape of your venue's SDK client.
 *
 * Example for a DEX:
 *   export interface SdkLike {
 *     getOrderBook(pair: string): Promise<{ bids: Order[]; asks: Order[] }>;
 *     getPairs(): Promise<PairInfo[]>;
 *   }
 *
 * Example for an on-chain perp:
 *   export interface SdkLike {
 *     markets: { getAll(): Promise<MarketInfo[]> };
 *     oracle: { getPrices(): Promise<PriceEntry[]> };
 *   }
 */
export interface SdkLike {
  // TODO: Add the methods your strategies need from the venue's SDK
}

// ─── Example Strategy: Spread Capture ───────────────────────────────────
// This is a skeleton. Replace the logic with your actual strategy.

/**
 * Scan for spread capture opportunities.
 *
 * TODO: Replace this with your real strategy logic. This skeleton shows
 * the expected function signature and return type.
 *
 * @param sdk    - Venue SDK client (or your SdkLike mock in tests)
 * @param config - Venue config from environment
 * @param logger - Pino logger for structured logging
 * @returns      - Array of signals, sorted by strength, max 5
 */
export async function scanExample(
  sdk: SdkLike,
  config: %%VENUE_NAME%%Config,
  logger: Logger,
): Promise<%%VENUE_NAME%%Signal[]> {
  const signals: %%VENUE_NAME%%Signal[] = [];

  try {
    // ── Step 1: Fetch market data from the SDK ──────────────────────
    // TODO: Call the SDK to get market data.
    // Example:
    //   const markets = await sdk.getPairs();
    //   if (!markets || markets.length === 0) return signals;

    // ── Step 2: Iterate markets and apply filters ───────────────────
    // TODO: Loop through markets, skip ones that don't meet your criteria.
    // Example:
    //   for (const market of markets) {
    //     if (market.volume24h < config.minVolume) continue;
    //
    //     const spread = (market.bestAsk - market.bestBid) / market.bestBid;
    //     if (spread < 0.005) continue; // skip tight spreads
    //
    //     const direction = "buy" as const;
    //     const size = Math.min(config.maxPosition, config.dailyCap * 0.25);
    //
    //     signals.push({
    //       market: market.id,
    //       asset: market.baseAsset,
    //       strategy: "spread_capture",
    //       direction,
    //       entry: market.bestBid,
    //       size_usd: size,
    //       leverage: 1,
    //       rationale: `${market.baseAsset} spread ${(spread * 100).toFixed(2)}% — buy bid side`,
    //     });
    //   }

    logger.debug("%%VENUE_NAME%% example strategy: not yet implemented");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "%%VENUE_NAME%% scan failed",
    );
  }

  // ── Step 3: Sort by signal strength and cap at 5 ──────────────────
  // TODO: Sort by whatever metric indicates signal quality.
  // signals.sort((a, b) => b.some_metric - a.some_metric);
  logger.debug({ count: signals.length }, "%%VENUE_NAME%% signals");
  return signals.slice(0, 5);
}

// ─── Add more strategies below ──────────────────────────────────────────
// Follow the same pattern: async function, takes (sdk, config, logger),
// returns Signal[]. Export each one from index.ts.
//
// Common strategy types in this codebase:
//   - Funding rate capture (collect funding on extreme rates)
//   - Momentum (ride strong directional moves)
//   - Mean reversion (fade extremes)
//   - Spread capture (profit from bid-ask spread)
//   - Liquidity provision (provide liquidity, earn fees)
//   - Arbitrage (cross-venue price differences)
