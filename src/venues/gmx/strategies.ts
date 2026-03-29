/**
 * GMX Trading Strategies
 *
 * - Funding Rate Capture: collect funding on extreme-rate perps
 * - Momentum: ride strong 24h moves with GMX native TP/SL
 * - GM Pool Yield: signal-only scan for high-yield liquidity pools
 *
 * Requires `@gmx-io/sdk` for market data.
 */

import type { Logger } from "../../logger.js";
import type { GmxSignal, GmxConfig } from "./types.js";

/** Minimal shape of what we use from GmxSdk — avoids hard import for testability */
export interface GmxSdkLike {
  markets: {
    getMarketsInfo: () => Promise<Record<string, unknown>>;
    getDailyVolumes: () => Promise<Record<string, unknown>>;
  };
  oracle: {
    getTickers: () => Promise<Record<string, { minPrice: bigint; maxPrice: bigint }>>;
  };
}

/**
 * Scan funding rates across all GMX perp markets on Arbitrum.
 * GMX V2 funding updates hourly; captures rates for shorts (positive) and longs (negative).
 */
export async function scanFunding(
  sdk: GmxSdkLike,
  config: GmxConfig,
  logger: Logger
): Promise<GmxSignal[]> {
  const signals: GmxSignal[] = [];

  try {
    const marketsInfo = await sdk.markets.getMarketsInfo();
    const tickers = await sdk.oracle.getTickers();

    const markets = Object.values(marketsInfo) as Array<Record<string, unknown>>;

    for (const market of markets) {
      if (!market || market.isDisabled) continue;

      const marketToken = market.marketTokenAddress as string;
      const indexToken = (market.indexToken as Record<string, unknown>)?.symbol as string;
      if (!indexToken || market.isSpotOnly) continue;

      // Extract funding rate from market info
      const longFundingRate = Number(market.longsPayShorts ?? 0);
      const fundingRate = longFundingRate; // positive = longs pay shorts

      // Get current price from tickers
      const ticker = tickers[marketToken];
      if (!ticker) continue;

      const price = Number(ticker.maxPrice) / 1e30; // GMX stores prices with 30 decimals
      if (price <= 0) continue;

      const annualized = fundingRate * 24 * 365;
      if (Math.abs(annualized) < config.fundingThreshold) continue;

      const direction = fundingRate > 0 ? ("short" as const) : ("long" as const);
      const size = Math.min(config.maxPosition, config.dailyCap * 0.3);

      signals.push({
        market: marketToken,
        indexToken,
        strategy: "funding",
        direction,
        entry: price,
        size_usd: size,
        leverage: Math.min(3, config.maxLeverage),
        funding_rate: fundingRate,
        funding_annualized: annualized,
        rationale: `${indexToken} funding ${(annualized * 100).toFixed(1)}% annualized on GMX — ${direction} to collect`,
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "GMX funding scan failed");
  }

  signals.sort((a, b) => Math.abs(b.funding_annualized || 0) - Math.abs(a.funding_annualized || 0));
  logger.debug({ count: signals.length }, "GMX funding signals");
  return signals.slice(0, 5);
}

/**
 * Scan 24h momentum across GMX markets.
 * GMX advantage: native take-profit and stop-loss orders (two-phase execution, MEV protected).
 */
export async function scanMomentum(
  sdk: GmxSdkLike,
  config: GmxConfig,
  logger: Logger
): Promise<GmxSignal[]> {
  const signals: GmxSignal[] = [];

  try {
    const marketsInfo = await sdk.markets.getMarketsInfo();
    const tickers = await sdk.oracle.getTickers();
    let volumes: Record<string, unknown> = {};
    try {
      volumes = await sdk.markets.getDailyVolumes();
    } catch { /* volume data optional */ }

    const markets = Object.values(marketsInfo) as Array<Record<string, unknown>>;

    for (const market of markets) {
      if (!market || market.isDisabled || market.isSpotOnly) continue;

      const marketToken = market.marketTokenAddress as string;
      const indexToken = (market.indexToken as Record<string, unknown>)?.symbol as string;
      if (!indexToken) continue;

      const ticker = tickers[marketToken];
      if (!ticker) continue;

      const currentPrice = Number(ticker.maxPrice) / 1e30;
      if (currentPrice <= 0) continue;

      // Check volume if available
      const vol = volumes[marketToken] as Record<string, unknown> | undefined;
      const volume24h = vol ? Number(vol.volume || 0) : 0;
      if (volume24h > 0 && volume24h < config.minVolume24h) continue;

      // Use market's stored 24h price change if available, else skip
      const prevPrice = Number(market.prevDayPrice ?? 0) / 1e30;
      if (prevPrice <= 0) continue;

      const change = (currentPrice - prevPrice) / prevPrice;
      if (Math.abs(change) < config.momentumThreshold) continue;

      const direction = change > 0 ? ("long" as const) : ("short" as const);
      const size = Math.min(config.maxPosition, config.dailyCap * 0.25);

      signals.push({
        market: marketToken,
        indexToken,
        strategy: "momentum",
        direction,
        entry: currentPrice,
        size_usd: size,
        leverage: Math.min(2, config.maxLeverage),
        momentum_pct: change,
        rationale: `${indexToken} ${(change * 100).toFixed(1)}% on GMX in 24h — ${direction} momentum (native TP/SL available)`,
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "GMX momentum scan failed");
  }

  signals.sort((a, b) => Math.abs(b.momentum_pct || 0) - Math.abs(a.momentum_pct || 0));
  logger.debug({ count: signals.length }, "GMX momentum signals");
  return signals.slice(0, 5);
}

/**
 * Scan GM pool yields — signal-only, no execution.
 * Flags pools with APY above the configured minimum for human review or future automation.
 */
export async function scanGmPools(
  sdk: GmxSdkLike,
  config: GmxConfig,
  logger: Logger
): Promise<GmxSignal[]> {
  if (!config.gmPoolEnabled) return [];

  const signals: GmxSignal[] = [];

  try {
    const marketsInfo = await sdk.markets.getMarketsInfo();
    const tickers = await sdk.oracle.getTickers();
    const markets = Object.values(marketsInfo) as Array<Record<string, unknown>>;

    for (const market of markets) {
      if (!market) continue;

      const marketToken = market.marketTokenAddress as string;
      const indexToken = (market.indexToken as Record<string, unknown>)?.symbol as string || "SPOT";

      const ticker = tickers[marketToken];
      if (!ticker) continue;

      const price = Number(ticker.maxPrice) / 1e30;

      // Extract pool APY from market data if available
      const poolApy = Number(market.apy ?? market.poolApy ?? 0);
      if (poolApy < config.gmMinApy) continue;

      signals.push({
        market: marketToken,
        indexToken,
        strategy: "gm_pool",
        direction: "long",
        entry: price,
        size_usd: 0, // signal-only, no sizing
        leverage: 1,
        pool_apy: poolApy,
        rationale: `GM ${indexToken} pool ${poolApy.toFixed(1)}% APY — LP yield opportunity`,
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "GMX GM pool scan failed");
  }

  signals.sort((a, b) => (b.pool_apy || 0) - (a.pool_apy || 0));
  logger.debug({ count: signals.length }, "GMX GM pool signals");
  return signals.slice(0, 5);
}
