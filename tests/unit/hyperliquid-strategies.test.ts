import { describe, it, expect } from "vitest";
import { scanFunding, scanMomentum } from "../../src/venues/hyperliquid/strategies.js";
import type { HyperliquidConfig } from "../../src/venues/hyperliquid/types.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

const defaultConfig: HyperliquidConfig = {
  dryRun: true,
  dailyCap: 50,
  maxPosition: 25,
  maxLeverage: 5,
  fundingThreshold: 0.01,
  momentumThreshold: 0.02,
  minVolume24h: 1_000_000,
};

function makeSdk(assets: Array<{ name: string; funding?: string; markPx?: string; prevDayPx?: string; dayNtlVlm?: string }>) {
  return {
    info: {
      perpetuals: {
        getMetaAndAssetCtxs: async () => [
          { universe: assets.map((a) => ({ name: a.name })) },
          assets.map((a) => ({
            funding: a.funding || "0",
            markPx: a.markPx || "100",
            prevDayPx: a.prevDayPx || "100",
            dayNtlVlm: a.dayNtlVlm || "5000000",
          })),
        ],
      },
    },
  };
}

describe("Hyperliquid strategies", () => {
  describe("scanFunding", () => {
    it("detects positive funding → short signal", async () => {
      const sdk = makeSdk([
        { name: "ETH", funding: "0.001", markPx: "3000", dayNtlVlm: "50000000" },
      ]);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("short");
      expect(signals[0].strategy).toBe("funding");
    });

    it("detects negative funding → long signal", async () => {
      const sdk = makeSdk([
        { name: "BTC", funding: "-0.002", markPx: "60000", dayNtlVlm: "100000000" },
      ]);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("long");
    });

    it("skips assets below volume threshold", async () => {
      const sdk = makeSdk([
        { name: "MEME", funding: "0.01", markPx: "0.05", dayNtlVlm: "500" },
      ]);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });

    it("skips assets below funding threshold", async () => {
      const sdk = makeSdk([
        { name: "ETH", funding: "0.000001", markPx: "3000", dayNtlVlm: "50000000" },
      ]);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });

    it("returns max 5 signals sorted by abs funding", async () => {
      const assets = Array.from({ length: 10 }, (_, i) => ({
        name: `COIN${i}`,
        funding: String(0.001 * (i + 1)),
        markPx: "100",
        dayNtlVlm: "5000000",
      }));
      const sdk = makeSdk(assets);
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals.length).toBeLessThanOrEqual(5);
      // Should be sorted descending by abs funding
      for (let i = 1; i < signals.length; i++) {
        expect(Math.abs(signals[i - 1].funding_annualized!)).toBeGreaterThanOrEqual(
          Math.abs(signals[i].funding_annualized!)
        );
      }
    });

    it("handles empty SDK response", async () => {
      const sdk = { info: { perpetuals: { getMetaAndAssetCtxs: async () => [] } } };
      const signals = await scanFunding(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });
  });

  describe("scanMomentum", () => {
    it("detects upward momentum → long signal", async () => {
      const sdk = makeSdk([
        { name: "SOL", markPx: "150", prevDayPx: "130", dayNtlVlm: "20000000" },
      ]);
      const signals = await scanMomentum(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("long");
      expect(signals[0].momentum_pct).toBeGreaterThan(0);
    });

    it("detects downward momentum → short signal", async () => {
      const sdk = makeSdk([
        { name: "DOGE", markPx: "0.10", prevDayPx: "0.15", dayNtlVlm: "10000000" },
      ]);
      const signals = await scanMomentum(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe("short");
      expect(signals[0].momentum_pct).toBeLessThan(0);
    });

    it("skips low-volume assets", async () => {
      const sdk = makeSdk([
        { name: "MICRO", markPx: "200", prevDayPx: "100", dayNtlVlm: "100" },
      ]);
      const signals = await scanMomentum(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });

    it("skips below momentum threshold", async () => {
      const sdk = makeSdk([
        { name: "ETH", markPx: "3001", prevDayPx: "3000", dayNtlVlm: "50000000" },
      ]);
      const signals = await scanMomentum(sdk, defaultConfig, mockLogger());
      expect(signals).toHaveLength(0);
    });
  });
});
