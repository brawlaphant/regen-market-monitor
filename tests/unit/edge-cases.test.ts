/**
 * Edge case tests for various modules.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { PolymarketClient } from "../../src/venues/polymarket/client.js";
import { RelayClient } from "../../src/litcoin/relay-client.js";
import type { RelayConfig } from "../../src/litcoin/types.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("PolymarketClient edge cases", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parseCrowdPrice returns null for empty array outcomePrices", () => {
    const client = new PolymarketClient(mockLogger());
    const price = client.parseCrowdPrice({
      id: "1", question: "test", outcomePrices: "[]",
      volume: "1000", liquidity: "500", active: true, closed: false, conditionId: "abc",
    });
    expect(price).toBeNull();
  });

  it("parseCrowdPrice returns null for non-numeric first price", () => {
    const client = new PolymarketClient(mockLogger());
    const price = client.parseCrowdPrice({
      id: "1", question: "test", outcomePrices: '["abc","def"]',
      volume: "1000", liquidity: "500", active: true, closed: false, conditionId: "abc",
    });
    expect(price).toBeNull();
  });

  it("fetchMarkets returns empty array for non-array API response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ error: "rate limited" }),
    }));
    const client = new PolymarketClient(mockLogger());
    const markets = await client.fetchMarkets(10);
    expect(markets).toHaveLength(0);
  });

  it("fetchMarkets handles events with null markets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => [
        { id: "e1", slug: "s", title: "T", markets: null },
        { id: "e2", slug: "s2", title: "T2" }, // no markets field
      ],
    }));
    const client = new PolymarketClient(mockLogger());
    const markets = await client.fetchMarkets(10);
    expect(markets).toHaveLength(0);
  });

  it("fetchMarkets propagates network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));
    const client = new PolymarketClient(mockLogger());
    await expect(client.fetchMarkets(10)).rejects.toThrow("Connection refused");
  });

  it("fetchMarkets returns empty for empty events array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => [],
    }));
    const client = new PolymarketClient(mockLogger());
    const markets = await client.fetchMarkets(10);
    expect(markets).toHaveLength(0);
  });
});

describe("RelayClient edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "relay-edge-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeConfig(): RelayConfig {
    return {
      baseUrl: "https://api.litcoiin.xyz/v1", authMethod: "key", apiKey: "test",
      timeoutMs: 5000, retryTimeoutMs: 10000, model: "auto",
    };
  }

  it("returns null for response with empty choices array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [], usage: { total_tokens: 10 } }),
    }));
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    const result = await client.chatCompletion([{ role: "user", content: "test" }]);
    expect(result).toBeNull();
  });

  it("returns null for response with no message in choice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{}], usage: { total_tokens: 10 } }),
    }));
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    const result = await client.chatCompletion([{ role: "user", content: "test" }]);
    expect(result).toBeNull();
  });

  it("skips burn tracking when response has no usage field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] }),
    }));
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    const result = await client.chatCompletion([{ role: "user", content: "test" }]);
    expect(result).toBe("hello");
    const stats = client.getBurnStats();
    expect(stats.burn_count).toBe(0); // no usage = no burn tracked
  });

  it("health check returns reachable=false on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({}),
    }));
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    const health = await client.checkHealth();
    expect(health.reachable).toBe(false);
  });

  it("health check success with relay_providers_online", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ relay_providers_online: 5, escrow_balance: 100 }),
    }));
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    const health = await client.checkHealth();
    expect(health.reachable).toBe(true);
    expect(health.relay_providers_online).toBe(5);
    expect(health.escrow_sufficient).toBe(true);
  });

  it("health check with low escrow balance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ relay_providers_online: 2, escrow_balance: 3 }),
    }));
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    const health = await client.checkHealth();
    expect(health.escrow_sufficient).toBe(false);
  });

  it("getLedger returns full ledger", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
      }),
    }));
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    await client.chatCompletion([{ role: "user", content: "test" }]);
    const ledger = client.getLedger();
    expect(ledger.burns).toHaveLength(1);
    expect(ledger.burns[0].purpose).toBe("general");
  });

  it("getLastHealth returns null before first check", () => {
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    expect(client.getLastHealth()).toBeNull();
  });
});

describe("Hyperliquid strategies edge cases", () => {
  it("scanFunding handles prevDayPx=0 without division by zero", async () => {
    const { scanMomentum } = await import("../../src/venues/hyperliquid/strategies.js");
    const sdk = {
      info: {
        perpetuals: {
          getMetaAndAssetCtxs: async () => [
            { universe: [{ name: "BTC" }] },
            [{ markPx: "60000", prevDayPx: "0", dayNtlVlm: "50000000", funding: "0" }],
          ],
        },
      },
    };
    const config = {
      dryRun: true, dailyCap: 50, maxPosition: 25, maxLeverage: 5,
      fundingThreshold: 0.01, momentumThreshold: 0.02, minVolume24h: 1000000,
    };
    // Should not crash — prevDayPx <= 0 guard prevents division
    const signals = await scanMomentum(sdk, config, mockLogger());
    expect(signals).toHaveLength(0);
  });

  it("scanFunding handles SDK throwing error", async () => {
    const { scanFunding } = await import("../../src/venues/hyperliquid/strategies.js");
    const sdk = {
      info: {
        perpetuals: {
          getMetaAndAssetCtxs: async () => { throw new Error("RPC timeout"); },
        },
      },
    };
    const config = {
      dryRun: true, dailyCap: 50, maxPosition: 25, maxLeverage: 5,
      fundingThreshold: 0.01, momentumThreshold: 0.02, minVolume24h: 1000000,
    };
    // Should propagate the error (caller handles via try/catch)
    await expect(scanFunding(sdk, config, mockLogger())).rejects.toThrow("RPC timeout");
  });

  it("scanFunding handles mismatched universe/contexts lengths", async () => {
    const { scanFunding } = await import("../../src/venues/hyperliquid/strategies.js");
    const sdk = {
      info: {
        perpetuals: {
          getMetaAndAssetCtxs: async () => [
            { universe: [{ name: "BTC" }, { name: "ETH" }, { name: "SOL" }] },
            [{ markPx: "60000", funding: "0.001", dayNtlVlm: "50000000" }], // only 1 context for 3 assets
          ],
        },
      },
    };
    const config = {
      dryRun: true, dailyCap: 50, maxPosition: 25, maxLeverage: 5,
      fundingThreshold: 0.01, momentumThreshold: 0.02, minVolume24h: 1000000,
    };
    // Should only process the first asset (where both universe[i] and contexts[i] exist)
    const signals = await scanFunding(sdk, config, mockLogger());
    expect(signals.length).toBeLessThanOrEqual(1);
  });

  it("loadLedger handles corrupt JSON file", async () => {
    const { loadLedger } = await import("../../src/venues/hyperliquid/ledger.js");
    const tmpDir = fs.mkdtempSync(path.join(tmpdir(), "hl-corrupt-"));
    const dir = path.join(tmpDir, "hyperliquid");
    fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().split("T")[0];
    fs.writeFileSync(path.join(dir, `ledger-${today}.json`), "not valid json{{{");

    const ledger = loadLedger(tmpDir);
    expect(ledger.date).toBe(today);
    expect(ledger.spent_usd).toBe(0);
    expect(ledger.trades).toHaveLength(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
