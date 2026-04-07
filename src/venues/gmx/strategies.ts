/**
 * GMX Trading Strategies
 *
 * - Funding Rate Capture: collect funding on extreme-rate perps
 * - Momentum: ride OI imbalance with GMX native TP/SL
 * - GM Pool Yield: signal-only scan for high-utilization liquidity pools
 *
 * Type mirrors match @gmx-io/sdk v1.5.x actual return shapes so strategies
 * are testable without importing the full SDK.
 */

import type { Logger } from "../../logger.js";
import type { GmxSignal, GmxConfig } from "./types.js";
import { kellySize, signalToKellyInput } from "../../execution/trading-risk.js";

// ─── SDK type mirrors (match @gmx-io/sdk actual return shapes) ───────

/** Ticker as returned by the GMX oracle REST API — an array element, NOT a keyed record */
export interface TickerEntry {
  minPrice: string;
  maxPrice: string;
  oracleDecimals: number;
  tokenSymbol: string;
  tokenAddress: string;
  updatedAt: number;
}

/** Minimal MarketInfo shape — fields we actually read from MarketsInfoData values */
export interface MarketInfoLike {
  marketTokenAddress: string;
  indexToken: { symbol: string; address: string };
  indexTokenAddress: string;
  isDisabled: boolean;
  isSpotOnly: boolean;
  /** Per-second funding factor (bigint, 30 decimals in the real SDK) */
  fundingFactorPerSecond: bigint;
  /** True when longs pay shorts, false when shorts pay longs */
  longsPayShorts: boolean;
  longInterestUsd: bigint;
  shortInterestUsd: bigint;
  /** Pool value (max estimate) — used for utilization/APY estimation */
  poolValueMax?: bigint;
}

/** Minimal shape of what we use from GmxSdk — avoids hard import for testability */
export interface GmxSdkLike {
  markets: {
    /** Real SDK returns { marketsInfoData?, tokensData?, pricesUpdatedAt? } */
    getMarketsInfo: () => Promise<{
      marketsInfoData?: Record<string, MarketInfoLike>;
      tokensData?: Record<string, unknown>;
      pricesUpdatedAt?: number;
    }>;
    getDailyVolumes: () => Promise<Record<string, bigint> | undefined>;
  };
  oracle: {
    /** Real SDK returns TickerEntry[] (array, NOT a keyed record) */
    getTickers: () => Promise<TickerEntry[]>;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Build a lookup map from the tickers array, keyed by lowercased tokenAddress */
function buildTickerMap(tickers: TickerEntry[]): Map<string, TickerEntry> {
  const map = new Map<string, TickerEntry>();
  for (const t of tickers) {
    map.set(t.tokenAddress.toLowerCase(), t);
  }
  return map;
}

/** Parse a price string from the oracle, adjusting for oracleDecimals */
function parseOraclePrice(priceStr: string, oracleDecimals: number): number {
  const raw = Number(priceStr);
  if (raw <= 0 || !isFinite(raw)) return 0;
  return raw / 10 ** oracleDecimals;
}

/** Convert fundingFactorPerSecond (30-decimal bigint) to an hourly rate */
function fundingPerSecondToHourly(factor: bigint): number {
  return Number(factor) / 1e30 * 3600;
}

// ─── Strategies ──────────────────────────────────────────────────────

/**
 * Scan funding rates across all GMX perp markets on Arbitrum.
 * GMX V2 funding is continuous; fundingFactorPerSecond is a 30-decimal bigint.
 * longsPayShorts is a boolean indicating direction.
 */
export async function scanFunding(
  sdk: GmxSdkLike,
  config: GmxConfig,
  logger: Logger
): Promise<GmxSignal[]> {
  const signals: GmxSignal[] = [];

  try {
    const { marketsInfoData } = await sdk.markets.getMarketsInfo();
    if (!marketsInfoData) return signals;

    const tickers = await sdk.oracle.getTickers();
    const tickerMap = buildTickerMap(tickers);

    const markets = Object.values(marketsInfoData);

    for (const market of markets) {
      if (!market || market.isDisabled) continue;
      if (market.isSpotOnly) continue;

      const indexSymbol = market.indexToken?.symbol;
      if (!indexSymbol) continue;

      // Lookup ticker by index token address
      const ticker = tickerMap.get(market.indexTokenAddress?.toLowerCase());
      if (!ticker) continue;

      const price = parseOraclePrice(ticker.maxPrice, ticker.oracleDecimals);
      if (price <= 0) continue;

      // Funding: fundingFactorPerSecond is the magnitude, longsPayShorts is the direction
      const hourlyRate = fundingPerSecondToHourly(market.fundingFactorPerSecond);
      const signedRate = market.longsPayShorts ? hourlyRate : -hourlyRate;
      const annualized = signedRate * 24 * 365;

      if (Math.abs(annualized) < config.fundingThreshold) continue;

      // Positive signedRate = longs pay shorts → short to collect
      const direction = signedRate > 0 ? ("short" as const) : ("long" as const);
      const ki = signalToKellyInput("funding", { fundingAnnualized: annualized });
      const kellyS = kellySize({ edge: ki.edge, confidence: ki.confidence, bankroll: config.dailyCap, maxPct: 0.30 });
      const size = Math.min(config.maxPosition, kellyS);

      signals.push({
        market: market.marketTokenAddress,
        indexToken: indexSymbol,
        strategy: "funding",
        direction,
        entry: price,
        size_usd: size,
        leverage: Math.min(3, config.maxLeverage),
        funding_rate: signedRate,
        funding_annualized: annualized,
        rationale: `${indexSymbol} funding ${(annualized * 100).toFixed(1)}% annualized on GMX — ${direction} to collect`,
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
 * Scan momentum across GMX markets via open interest imbalance.
 * The SDK doesn't expose 24h price candles directly; OI skew is a strong
 * proxy for directional conviction from leveraged traders.
 *
 * GMX advantage: native take-profit and stop-loss orders (two-phase execution, MEV protected).
 */
export async function scanMomentum(
  sdk: GmxSdkLike,
  config: GmxConfig,
  logger: Logger
): Promise<GmxSignal[]> {
  const signals: GmxSignal[] = [];

  try {
    const { marketsInfoData } = await sdk.markets.getMarketsInfo();
    if (!marketsInfoData) return signals;

    const tickers = await sdk.oracle.getTickers();
    const tickerMap = buildTickerMap(tickers);

    let volumes: Record<string, bigint> | undefined;
    try {
      volumes = await sdk.markets.getDailyVolumes() ?? undefined;
    } catch { /* volume data optional */ }

    const markets = Object.values(marketsInfoData);

    for (const market of markets) {
      if (!market || market.isDisabled || market.isSpotOnly) continue;

      const indexSymbol = market.indexToken?.symbol;
      if (!indexSymbol) continue;

      const ticker = tickerMap.get(market.indexTokenAddress?.toLowerCase());
      if (!ticker) continue;

      const currentPrice = parseOraclePrice(ticker.maxPrice, ticker.oracleDecimals);
      if (currentPrice <= 0) continue;

      // Check volume if available
      if (volumes) {
        const vol = volumes[market.marketTokenAddress];
        if (vol !== undefined && Number(vol) < config.minVolume24h) continue;
      }

      // OI imbalance as momentum proxy: (longOI - shortOI) / totalOI
      const longOI = Number(market.longInterestUsd) / 1e30;
      const shortOI = Number(market.shortInterestUsd) / 1e30;
      const totalOI = longOI + shortOI;
      if (totalOI <= 0) continue;

      const imbalance = (longOI - shortOI) / totalOI; // range: -1 to +1
      if (Math.abs(imbalance) < config.momentumThreshold) continue;

      const direction = imbalance > 0 ? ("long" as const) : ("short" as const);
      const ki = signalToKellyInput("momentum", { momentumPct: imbalance });
      const kellyS = kellySize({ edge: ki.edge, confidence: ki.confidence, bankroll: config.dailyCap, maxPct: 0.25 });
      const size = Math.min(config.maxPosition, kellyS);

      signals.push({
        market: market.marketTokenAddress,
        indexToken: indexSymbol,
        strategy: "momentum",
        direction,
        entry: currentPrice,
        size_usd: size,
        leverage: Math.min(2, config.maxLeverage),
        momentum_pct: imbalance,
        rationale: `${indexSymbol} OI ${direction}-skewed ${(Math.abs(imbalance) * 100).toFixed(1)}% on GMX — ${direction} momentum (native TP/SL available)`,
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
 * Estimates yield from pool utilization (OI / pool value). Higher utilization
 * means more trading fees accrue to LPs. Actual APY varies with volume and
 * can be refined via the GMX stats API.
 */
export async function scanGmPools(
  sdk: GmxSdkLike,
  config: GmxConfig,
  logger: Logger
): Promise<GmxSignal[]> {
  if (!config.gmPoolEnabled) return [];

  const signals: GmxSignal[] = [];

  try {
    const { marketsInfoData } = await sdk.markets.getMarketsInfo();
    if (!marketsInfoData) return signals;

    const tickers = await sdk.oracle.getTickers();
    const tickerMap = buildTickerMap(tickers);

    const markets = Object.values(marketsInfoData);

    for (const market of markets) {
      if (!market) continue;

      const indexSymbol = market.indexToken?.symbol || "SPOT";

      const ticker = tickerMap.get(market.indexTokenAddress?.toLowerCase());
      if (!ticker) continue;

      const price = parseOraclePrice(ticker.maxPrice, ticker.oracleDecimals);

      // Estimate utilization from OI vs pool value
      const totalOI = Number(market.longInterestUsd ?? 0n) + Number(market.shortInterestUsd ?? 0n);
      const poolValue = Number(market.poolValueMax ?? 0n);
      if (poolValue <= 0) continue;

      const utilization = totalOI / poolValue;
      const estimatedApy = utilization * 100; // rough proxy
      if (estimatedApy < config.gmMinApy) continue;

      signals.push({
        market: market.marketTokenAddress,
        indexToken: indexSymbol,
        strategy: "gm_pool",
        direction: "long",
        entry: price,
        size_usd: 0, // signal-only, no sizing
        leverage: 1,
        pool_apy: estimatedApy,
        rationale: `GM ${indexSymbol} pool ~${estimatedApy.toFixed(1)}% est. APY (${(utilization * 100).toFixed(0)}% utilization) — LP yield opportunity`,
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "GMX GM pool scan failed");
  }

  signals.sort((a, b) => (b.pool_apy || 0) - (a.pool_apy || 0));
  logger.debug({ count: signals.length }, "GMX GM pool signals");
  return signals.slice(0, 5);
}
