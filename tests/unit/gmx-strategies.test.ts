import { describe, it, expect } from "vitest";
import { scanFunding, scanMomentum, scanGmPools } from "../../src/venues/gmx/strategies.js";
import type { GmxConfig } from "../../src/venues/gmx/types.js";
import type { GmxSdkLike, MarketInfoLike, TickerEntry } from "../../src/venues/gmx/strategies.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

const defaultConfig: GmxConfig = {
  dryRun: true,
  dailyCap: 50,
  maxPosition: 25,
  maxLeverage: 10,
  fundingThreshold: 0.01,
  momentumThreshold: 0.02,
  minVolume24h: 1_000_000,
  chainId: 42161,
  rpcUrl: "https://arb1.arbitrum.io/rpc",
  gmPoolEnabled: false,
  gmMinApy: 10,
};

/** Build a MarketInfo-like object matching the real SDK shape */
function makeMarket(overrides: Partial<MarketInfoLike> & Record<string, unknown> = {}): MarketInfoLike {
  const addr = (overrides.marketTokenAddress as string) || "0xmarket1";
  const indexAddr = (overrides.indexTokenAddress as string) || "0xindex1";
  const symbol = (overrides.symbol as string) || "ETH";
  return {
    marketTokenAddress: addr,
    indexToken: { symbol, address: indexAddr },
    indexTokenAddress: indexAddr,
    isDisabled: (overrides.isDisabled as boolean) ?? false,
    isSpotOnly: (overrides.isSpotOnly as boolean) ?? false,
    fundingFactorPerSecond: (overrides.fundingFactorPerSecond as bigint) ?? 0n,
    longsPayShorts: (overrides.longsPayShorts as boolean) ?? true,
    longInterestUsd: (overrides.longInterestUsd as bigint) ?? 0n,
    shortInterestUsd: (overrides.shortInterestUsd as bigint) ?? 0n,
    ...(overrides.poolValueMax !== undefined ? { poolValueMax: overrides.poolValueMax } : {}),
  } as MarketInfoLike;
}

/** Build a ticker array matching the real SDK shape (array of entries, NOT keyed record) */
function makeTickers(entries: Array<{ address: string; price: number; decimals?: number }>): TickerEntry[] {
  return entries.map(e => ({
    tokenAddress: e.address,
    tokenSymbol: "TOKEN",
    minPrice: String(e.price * 10 ** (e.decimals ?? 8)),
    maxPrice: String(e.price * 10 ** (e.decimals ?? 8)),
    oracleDecimals: e.decimals ?? 8,
    updatedAt: Math.floor(Date.now() / 1000),
  }));
}

function makeSdk(
  markets: MarketInfoLike[] = [],
  tickers: TickerEntry[] = [],
  volumes?: Record<string, bigint>,
): GmxSdkLike {
  const marketsInfoData: Record<string, MarketInfoLike> = {};
  for (const m of markets) {
    marketsInfoData[m.marketTokenAddress] = m;
  }
  return {
    markets: {
      getMarketsInfo: async () => ({ marketsInfoData }),
      getDailyVolumes: async () => volumes,
    },
    oracle: {
      getTickers: async () => tickers,
    },
  };
}

describe("GMX strategies", () => {
  describe("scanFunding", () => {
    it("detects longs-pay-shorts → short signal", async () => {
      // fundingFactorPerSecond at 30 decimals: 1e24 per second = 0.001/s hourly = 3.6/hr
      // annualized = 3.6 * 24 * 365 = 31,536 → well above 0.01 threshold
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        indexTokenAddress: "0xidx1",
        symbol: "ETH",
        fundingFactorPerSecond: BigInt("1000000000000000000000000"), // 1e24
        longsPayShorts: true,
      });
      const tickers = makeTickers([{ address: "0xidx1", price: 3000 }]);
      const sdk = makeSdk([market], tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("short");
      expect(signals[0].strategy).toBe("funding");
      expect(signals[0].indexToken).toBe("ETH");
    });

    it("detects shorts-pay-longs → long signal", async () => {
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        indexTokenAddress: "0xidx1",
        symbol: "BTC",
        fundingFactorPerSecond: BigInt("1000000000000000000000000"), // 1e24
        longsPayShorts: false, // shorts pay longs
      });
      const tickers = makeTickers([{ address: "0xidx1", price: 60000 }]);
      const sdk = makeSdk([market], tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("long");
    });

    it("skips disabled markets", async () => {
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        indexTokenAddress: "0xidx1",
        isDisabled: true,
        fundingFactorPerSecond: BigInt("1000000000000000000000000000"),
        longsPayShorts: true,
      });
      const tickers = makeTickers([{ address: "0xidx1", price: 100 }]);
      const sdk = makeSdk([market], tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });

    it("skips spot-only markets", async () => {
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        indexTokenAddress: "0xidx1",
        isSpotOnly: true,
        fundingFactorPerSecond: BigInt("1000000000000000000000000000"),
        longsPayShorts: true,
      });
      const tickers = makeTickers([{ address: "0xidx1", price: 100 }]);
      const sdk = makeSdk([market], tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });

    it("skips below funding threshold", async () => {
      // Very small funding factor → annualized below 0.01
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        indexTokenAddress: "0xidx1",
        fundingFactorPerSecond: 1n, // negligible
        longsPayShorts: true,
      });
      const tickers = makeTickers([{ address: "0xidx1", price: 3000 }]);
      const sdk = makeSdk([market], tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });

    it("returns max 5 signals sorted by abs funding", async () => {
      const markets = Array.from({ length: 10 }, (_, i) =>
        makeMarket({
          marketTokenAddress: `0xm${i}`,
          indexTokenAddress: `0xidx${i}`,
          symbol: `COIN${i}`,
          fundingFactorPerSecond: BigInt(i + 1) * 10n ** 24n,
          longsPayShorts: true,
        })
      );
      const tickers = makeTickers(
        Array.from({ length: 10 }, (_, i) => ({ address: `0xidx${i}`, price: 100 }))
      );
      const sdk = makeSdk(markets, tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals.length).toBeLessThanOrEqual(5);
      for (let i = 1; i < signals.length; i++) {
        expect(Math.abs(signals[i - 1].funding_annualized!)).toBeGreaterThanOrEqual(
          Math.abs(signals[i].funding_annualized!)
        );
      }
    });

    it("handles SDK error gracefully", async () => {
      const sdk: GmxSdkLike = {
        markets: {
          getMarketsInfo: async () => { throw new Error("RPC down"); },
          getDailyVolumes: async () => undefined,
        },
        oracle: { getTickers: async () => [] },
      };
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });
  });

  describe("scanMomentum", () => {
    it("detects long-skewed OI → long signal", async () => {
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        indexTokenAddress: "0xidx1",
        symbol: "SOL",
        longInterestUsd: 80n * 10n ** 30n,  // 80 USD (scaled by 1e30)
        shortInterestUsd: 20n * 10n ** 30n, // 20 USD
      });
      const tickers = makeTickers([{ address: "0xidx1", price: 150 }]);
      const sdk = makeSdk([market], tickers);
      const signals = await scanMomentum(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("long");
      expect(signals[0].momentum_pct).toBeGreaterThan(0);
    });

    it("detects short-skewed OI → short signal", async () => {
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        indexTokenAddress: "0xidx1",
        symbol: "DOGE",
        longInterestUsd: 20n * 10n ** 30n,
        shortInterestUsd: 80n * 10n ** 30n,
      });
      const tickers = makeTickers([{ address: "0xidx1", price: 0.1, decimals: 12 }]);
      const sdk = makeSdk([market], tickers);
      const signals = await scanMomentum(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("short");
    });

    it("skips balanced OI below momentum threshold", async () => {
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        indexTokenAddress: "0xidx1",
        symbol: "ETH",
        longInterestUsd: 50n * 10n ** 30n,
        shortInterestUsd: 50n * 10n ** 30n, // perfectly balanced → 0% imbalance
      });
      const tickers = makeTickers([{ address: "0xidx1", price: 3000 }]);
      const sdk = makeSdk([market], tickers);
      const signals = await scanMomentum(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });
  });

  describe("scanGmPools", () => {
    it("returns empty when disabled", async () => {
      const sdk = makeSdk();
      const signals = await scanGmPools(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });

    it("detects high-utilization GM pools when enabled", async () => {
      const config = { ...defaultConfig, gmPoolEnabled: true, gmMinApy: 5 };
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        indexTokenAddress: "0xidx1",
        symbol: "ETH",
        longInterestUsd: 30n * 10n ** 30n,
        shortInterestUsd: 30n * 10n ** 30n,
      });
      // Add poolValueMax for utilization calc
      (market as any).poolValueMax = 100n * 10n ** 30n;
      const tickers = makeTickers([{ address: "0xidx1", price: 3000 }]);
      const sdk = makeSdk([market], tickers);
      const signals = await scanGmPools(sdk, config, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].strategy).toBe("gm_pool");
      // utilization = 60/100 = 0.6, estimatedApy = 60
      expect(signals[0].pool_apy).toBeGreaterThan(5);
    });

    it("skips pools below min APY", async () => {
      const config = { ...defaultConfig, gmPoolEnabled: true, gmMinApy: 80 };
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        indexTokenAddress: "0xidx1",
        symbol: "ETH",
        longInterestUsd: 10n * 10n ** 30n,
        shortInterestUsd: 10n * 10n ** 30n,
      });
      (market as any).poolValueMax = 100n * 10n ** 30n;
      const tickers = makeTickers([{ address: "0xidx1", price: 3000 }]);
      const sdk = makeSdk([market], tickers);
      const signals = await scanGmPools(sdk, config, mockLogger());
      expect(signals).toHaveLength(0);
    });
  });
});
