/**
 * Base EcoWealth Strategies Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { scanParentLedger } from "../strategies.js";
import type { BaseEcowealthConfig } from "../types.js";

const mockConfig: BaseEcowealthConfig = {
  parentLedgerUrl: "http://localhost:3099",
  confidenceThreshold: 0.3,
  dryRun: true,
  scanInterval: 300_000,
};

const mockLedgerResponse = {
  trades: [
    {
      timestamp: new Date().toISOString(),
      symbol: "LITCOIN",
      side: "sell" as const,
      size: 1.0,
      price: 100,
      realized_pnl: 50,
    },
  ],
  prices: {
    LITCOIN: 100,
    WETH: 2000,
    REGEN: 0.5,
    ECOWEALTH: 0.001,
    USDC: 1.0,
  },
  yields: {
    litcoin_mined_today: 2.5,
    staking_yield_24h: 1.2,
  },
  gas_spent_24h: 0.01,
  pnl_24h: 750,
  metadata: {
    wallet: "0xc91B...",
    last_trade: new Date().toISOString(),
    total_trades_lifetime: 42,
    updatedAt: new Date().toISOString(),
  },
};

describe("Base EcoWealth Strategies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should generate litcoin_accumulation signal when mining yield > 0", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockLedgerResponse,
    }) as any;

    const signals = await scanParentLedger(mockConfig);

    const litSignal = signals.find((s) => s.strategy === "litcoin_accumulation");
    expect(litSignal).toBeDefined();
    expect(litSignal?.asset).toBe("LITCOIN/WETH");
    expect(litSignal?.metrics.litcoin_mined_today).toBe(2.5);
    expect(litSignal?.metrics.price_usd).toBe(100);
  });

  it("should generate ecowealth_fdv signal when ECOWEALTH buys detected", async () => {
    const ledgerWithEcoBuy = {
      ...mockLedgerResponse,
      trades: [
        ...mockLedgerResponse.trades,
        {
          timestamp: new Date().toISOString(),
          symbol: "ECOWEALTH",
          side: "buy" as const,
          size: 1000,
          price: 0.001,
          realized_pnl: 0,
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ledgerWithEcoBuy,
    }) as any;

    const signals = await scanParentLedger(mockConfig);

    const ecoSignal = signals.find((s) => s.strategy === "ecowealth_fdv");
    expect(ecoSignal).toBeDefined();
    expect(ecoSignal?.direction).toBe("buy");
  });

  it("should generate regen_accumulation signal when P&L > $500", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...mockLedgerResponse,
        pnl_24h: 750, // > $500
      }),
    }) as any;

    const signals = await scanParentLedger(mockConfig);

    const regenSignal = signals.find((s) => s.strategy === "regen_accumulation");
    expect(regenSignal).toBeDefined();
    expect(regenSignal?.direction).toBe("buy");
    expect(regenSignal?.size_usd).toBe(150); // 20% of 750 P&L
  });

  it("should not generate regen_accumulation signal when P&L < $500", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...mockLedgerResponse,
        pnl_24h: 200, // < $500
      }),
    }) as any;

    const signals = await scanParentLedger(mockConfig);

    const regenSignal = signals.find((s) => s.strategy === "regen_accumulation");
    expect(regenSignal).toBeUndefined();
  });

  it("should generate yield_reinvestment signal when staking yield > 0", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockLedgerResponse,
    }) as any;

    const signals = await scanParentLedger(mockConfig);

    const yieldSignal = signals.find((s) => s.strategy === "yield_reinvestment");
    expect(yieldSignal).toBeDefined();
    expect(yieldSignal?.metrics.staking_yield_24h).toBe(1.2);
  });

  it("should filter signals by confidence threshold", async () => {
    const strictConfig: BaseEcowealthConfig = {
      ...mockConfig,
      confidenceThreshold: 0.95, // very strict
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockLedgerResponse,
    }) as any;

    const signals = await scanParentLedger(strictConfig);

    // Should filter out low-confidence signals
    for (const signal of signals) {
      expect(signal.metrics.confidence).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("should handle fetch errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("Network error")) as any;

    const signals = await scanParentLedger(mockConfig);

    expect(signals).toEqual([]);
  });

  it("should handle 202 (no data yet) gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 202,
      json: async () => ({ error: "not_started" }),
    }) as any;

    const signals = await scanParentLedger(mockConfig);

    expect(signals).toEqual([]);
  });

  it("should include correct metrics in all signals", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockLedgerResponse,
    }) as any;

    const signals = await scanParentLedger(mockConfig);

    for (const signal of signals) {
      expect(signal.metrics).toMatchObject({
        pnl_24h: expect.any(Number),
        gas_spent_24h: expect.any(Number),
        litcoin_mined_today: expect.any(Number),
        staking_yield_24h: expect.any(Number),
        price_usd: expect.any(Number),
        confidence: expect.any(Number),
      });
      expect(signal.metrics.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.metrics.confidence).toBeLessThanOrEqual(1);
    }
  });
});
