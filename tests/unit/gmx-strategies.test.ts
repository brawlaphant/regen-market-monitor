import { describe, it, expect } from "vitest";
import { scanFunding, scanMomentum, scanGmPools } from "../../src/venues/gmx/strategies.js";
import type { GmxConfig } from "../../src/venues/gmx/types.js";
import type { GmxSdkLike } from "../../src/venues/gmx/strategies.js";

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

function makeMarket(overrides: Record<string, unknown> = {}) {
  return {
    marketTokenAddress: overrides.marketTokenAddress || "0xmarket1",
    indexToken: { symbol: overrides.symbol || "ETH" },
    isDisabled: overrides.isDisabled || false,
    isSpotOnly: overrides.isSpotOnly || false,
    longsPayShorts: overrides.longsPayShorts ?? 0.001,
    prevDayPrice: overrides.prevDayPrice ?? BigInt(3000e30).toString(),
    apy: overrides.apy ?? 0,
    ...overrides,
  };
}

function makeSdk(
  markets: Record<string, unknown>[] = [],
  tickers: Record<string, { minPrice: bigint; maxPrice: bigint }> = {},
  volumes: Record<string, unknown> = {},
): GmxSdkLike {
  const marketsMap: Record<string, unknown> = {};
  for (const m of markets) {
    marketsMap[m.marketTokenAddress as string] = m;
  }
  return {
    markets: {
      getMarketsInfo: async () => marketsMap,
      getDailyVolumes: async () => volumes,
    },
    oracle: {
      getTickers: async () => tickers,
    },
  };
}

describe("GMX strategies", () => {
  describe("scanFunding", () => {
    it("detects positive funding → short signal", async () => {
      const market = makeMarket({ marketTokenAddress: "0xm1", symbol: "ETH", longsPayShorts: 0.002 });
      const tickers = { "0xm1": { minPrice: BigInt(3000e30), maxPrice: BigInt(3000e30) } };
      const sdk = makeSdk([market], tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("short");
      expect(signals[0].strategy).toBe("funding");
      expect(signals[0].indexToken).toBe("ETH");
    });

    it("detects negative funding → long signal", async () => {
      const market = makeMarket({ marketTokenAddress: "0xm1", symbol: "BTC", longsPayShorts: -0.003 });
      const tickers = { "0xm1": { minPrice: BigInt(60000e30), maxPrice: BigInt(60000e30) } };
      const sdk = makeSdk([market], tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("long");
    });

    it("skips disabled markets", async () => {
      const market = makeMarket({ marketTokenAddress: "0xm1", isDisabled: true, longsPayShorts: 0.01 });
      const tickers = { "0xm1": { minPrice: BigInt(100e30), maxPrice: BigInt(100e30) } };
      const sdk = makeSdk([market], tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });

    it("skips spot-only markets", async () => {
      const market = makeMarket({ marketTokenAddress: "0xm1", isSpotOnly: true, longsPayShorts: 0.01 });
      const tickers = { "0xm1": { minPrice: BigInt(100e30), maxPrice: BigInt(100e30) } };
      const sdk = makeSdk([market], tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });

    it("skips below funding threshold", async () => {
      const market = makeMarket({ marketTokenAddress: "0xm1", longsPayShorts: 0.000001 });
      const tickers = { "0xm1": { minPrice: BigInt(3000e30), maxPrice: BigInt(3000e30) } };
      const sdk = makeSdk([market], tickers);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });

    it("returns max 5 signals sorted by abs funding", async () => {
      const markets = Array.from({ length: 10 }, (_, i) =>
        makeMarket({ marketTokenAddress: `0xm${i}`, symbol: `COIN${i}`, longsPayShorts: 0.001 * (i + 1) })
      );
      const tickers: Record<string, { minPrice: bigint; maxPrice: bigint }> = {};
      for (let i = 0; i < 10; i++) {
        tickers[`0xm${i}`] = { minPrice: BigInt(100e30), maxPrice: BigInt(100e30) };
      }
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
        markets: { getMarketsInfo: async () => { throw new Error("RPC down"); }, getDailyVolumes: async () => ({}) },
        oracle: { getTickers: async () => ({}) },
      };
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });
  });

  describe("scanMomentum", () => {
    it("detects upward momentum → long signal", async () => {
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        symbol: "SOL",
        prevDayPrice: BigInt(130e30).toString(),
      });
      const tickers = { "0xm1": { minPrice: BigInt(150e30), maxPrice: BigInt(150e30) } };
      const sdk = makeSdk([market], tickers);
      const signals = await scanMomentum(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("long");
      expect(signals[0].momentum_pct).toBeGreaterThan(0);
    });

    it("detects downward momentum → short signal", async () => {
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        symbol: "DOGE",
        prevDayPrice: BigInt(15e28).toString(), // 0.15 * 1e30
      });
      const tickers = { "0xm1": { minPrice: BigInt(10e28), maxPrice: BigInt(10e28) } }; // 0.10
      const sdk = makeSdk([market], tickers);
      const signals = await scanMomentum(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("short");
    });

    it("skips below momentum threshold", async () => {
      const market = makeMarket({
        marketTokenAddress: "0xm1",
        symbol: "ETH",
        prevDayPrice: BigInt(3000e30).toString(),
      });
      const tickers = { "0xm1": { minPrice: BigInt(3001e30), maxPrice: BigInt(3001e30) } };
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

    it("detects high-yield GM pools when enabled", async () => {
      const config = { ...defaultConfig, gmPoolEnabled: true, gmMinApy: 5 };
      const market = makeMarket({ marketTokenAddress: "0xm1", symbol: "ETH", apy: 15.5 });
      const tickers = { "0xm1": { minPrice: BigInt(3000e30), maxPrice: BigInt(3000e30) } };
      const sdk = makeSdk([market], tickers);
      const signals = await scanGmPools(sdk, config, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].strategy).toBe("gm_pool");
      expect(signals[0].pool_apy).toBe(15.5);
    });

    it("skips pools below min APY", async () => {
      const config = { ...defaultConfig, gmPoolEnabled: true, gmMinApy: 20 };
      const market = makeMarket({ marketTokenAddress: "0xm1", symbol: "ETH", apy: 10 });
      const tickers = { "0xm1": { minPrice: BigInt(3000e30), maxPrice: BigInt(3000e30) } };
      const sdk = makeSdk([market], tickers);
      const signals = await scanGmPools(sdk, config, mockLogger());
      expect(signals).toHaveLength(0);
    });
  });
});
