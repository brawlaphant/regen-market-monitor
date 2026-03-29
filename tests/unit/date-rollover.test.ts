/**
 * Tests for date rollover in burn ledger and surplus router.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { RelayClient } from "../../src/litcoin/relay-client.js";
import { SurplusRouter } from "../../src/surplus/surplus-router.js";
import type { RelayConfig } from "../../src/litcoin/types.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeRelayConfig(): RelayConfig {
  return {
    baseUrl: "https://api.litcoiin.xyz/v1", authMethod: "key", apiKey: "test",
    timeoutMs: 5000, retryTimeoutMs: 10000, model: "auto",
  };
}

describe("Burn ledger date rollover", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "rollover-"));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resets ledger when date changes", async () => {
    // Start on day 1
    vi.setSystemTime(new Date("2026-03-28T10:00:00Z"));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "42" } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
    }));

    const client = new RelayClient(makeRelayConfig(), tmpDir, mockLogger());
    await client.chatCompletion([{ role: "user", content: "test" }], { purpose: "test" });

    let stats = client.getBurnStats();
    expect(stats.burn_count).toBe(1);
    expect(stats.total_tokens).toBe(110);

    // Advance to day 2
    vi.setSystemTime(new Date("2026-03-29T10:00:00Z"));

    // The next call should trigger a ledger reset
    await client.chatCompletion([{ role: "user", content: "test2" }], { purpose: "test" });

    stats = client.getBurnStats();
    // Should be 1 burn (only today's), not 2
    expect(stats.burn_count).toBe(1);
    expect(stats.total_tokens).toBe(110);
  });
});

describe("Surplus router date rollover", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "surplus-rollover-"));
    vi.useFakeTimers();
    delete process.env.TRADING_DESK_SURPLUS_FLOOR;
    delete process.env.TRADING_DESK_SURPLUS_PCT;
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resets daily counters but preserves cumulative on date change", () => {
    vi.setSystemTime(new Date("2026-03-28T10:00:00Z"));
    const router = new SurplusRouter(tmpDir, mockLogger());

    // Record day 1 P&L
    router.recordVenuePnl("polymarket", 50, 10, 3, 40);
    let pnl = router.getTodayPnl();
    expect(pnl.realized).toBe(50);
    expect(pnl.trades).toBe(3);

    // Check cumulative
    let state = router.getState();
    expect(state.cumulative_realized_usd).toBe(50);

    // Advance to day 2
    vi.setSystemTime(new Date("2026-03-29T10:00:00Z"));

    // Daily should reset
    pnl = router.getTodayPnl();
    expect(pnl.realized).toBe(0);
    expect(pnl.trades).toBe(0);

    // Cumulative should persist
    state = router.getState();
    expect(state.cumulative_realized_usd).toBe(50);

    // Record day 2 P&L
    router.recordVenuePnl("hyperliquid", 30, 0, 2, 20);
    pnl = router.getTodayPnl();
    expect(pnl.realized).toBe(30);

    state = router.getState();
    expect(state.cumulative_realized_usd).toBe(80);
  });

  it("handles negative P&L correctly", () => {
    vi.setSystemTime(new Date("2026-03-28T10:00:00Z"));
    process.env.TRADING_DESK_SURPLUS_FLOOR = "10";
    const router = new SurplusRouter(tmpDir, mockLogger());

    router.recordVenuePnl("polymarket", -25, 0, 2, 30);
    const surplus = router.calculateSurplus();
    expect(surplus.routed_to_regen_usd).toBe(0);
    expect(surplus.reason).toContain("below surplus floor");
  });
});
