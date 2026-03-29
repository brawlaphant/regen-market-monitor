import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SurplusRouter } from "../../src/surplus/surplus-router.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("SurplusRouter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "surplus-"));
    delete process.env.TRADING_DESK_SURPLUS_FLOOR;
    delete process.env.TRADING_DESK_SURPLUS_PCT;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts with zero P&L", () => {
    const router = new SurplusRouter(tmpDir, mockLogger());
    const pnl = router.getTodayPnl();
    expect(pnl.realized).toBe(0);
    expect(pnl.trades).toBe(0);
  });

  it("records venue P&L", () => {
    const router = new SurplusRouter(tmpDir, mockLogger());
    router.recordVenuePnl("polymarket", 25, 10, 3, 40);
    router.recordVenuePnl("hyperliquid", 15, 5, 2, 30);

    const pnl = router.getTodayPnl();
    expect(pnl.realized).toBe(40);
    expect(pnl.trades).toBe(5);
    expect(pnl.spent).toBe(70);
  });

  it("returns no surplus when below floor", () => {
    process.env.TRADING_DESK_SURPLUS_FLOOR = "100";
    const router = new SurplusRouter(tmpDir, mockLogger());
    router.recordVenuePnl("polymarket", 30, 0, 1, 20);

    const surplus = router.calculateSurplus();
    expect(surplus.routed_to_regen_usd).toBe(0);
    expect(surplus.reason).toContain("below surplus floor");
  });

  it("routes surplus percentage above floor", () => {
    process.env.TRADING_DESK_SURPLUS_FLOOR = "50";
    process.env.TRADING_DESK_SURPLUS_PCT = "20";
    const router = new SurplusRouter(tmpDir, mockLogger());
    router.recordVenuePnl("polymarket", 100, 0, 5, 50);

    const surplus = router.calculateSurplus();
    // 100 - 50 floor = 50 surplus, 20% = $10
    expect(surplus.available_surplus_usd).toBe(50);
    expect(surplus.routed_to_regen_usd).toBe(10);
  });

  it("tracks cumulative surplus routed", () => {
    process.env.TRADING_DESK_SURPLUS_FLOOR = "10";
    process.env.TRADING_DESK_SURPLUS_PCT = "50";
    const router = new SurplusRouter(tmpDir, mockLogger());
    router.recordVenuePnl("polymarket", 100, 0, 1, 0);

    // First calculation: surplus = 100-10=90, route 50% = $45
    router.markRouted(45);

    // After routing, surplus should be reduced
    const surplus = router.calculateSurplus();
    // cumulative_realized=100, cumulative_routed=45, net=55, floor=10, surplus=45
    expect(surplus.available_surplus_usd).toBe(45);
  });

  it("persists state to disk", () => {
    const router = new SurplusRouter(tmpDir, mockLogger());
    router.recordVenuePnl("hyperliquid", 50, 0, 2, 30);

    const file = path.join(tmpDir, "pnl-state.json");
    expect(fs.existsSync(file)).toBe(true);

    // Load new instance from same dir — state should persist
    const router2 = new SurplusRouter(tmpDir, mockLogger());
    const state = router2.getState();
    expect(state.cumulative_realized_usd).toBe(50);
  });
});
