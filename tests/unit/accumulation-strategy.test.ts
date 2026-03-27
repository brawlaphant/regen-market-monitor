import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AccumulationStrategy } from "../../src/strategies/accumulation-strategy.js";
import { BankrAdapter } from "../../src/execution/bankr-adapter.js";
import type { CrossChainSnapshot, VenuePrice } from "../../src/chain/cross-chain-aggregator.js";
import type { TradingSignal } from "../../src/signals/trading-signal.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeSnapshot(overrides: Partial<CrossChainSnapshot> = {}): CrossChainSnapshot {
  return {
    timestamp: new Date().toISOString(),
    venues: [
      { venue: "hydrex_base" as any, price_usd: 0.04, volume_24h_usd: 50000, liquidity_usd: 100000, last_updated: new Date().toISOString(), source_url: "", confidence: "high" },
      { venue: "osmosis" as any, price_usd: 0.04, volume_24h_usd: 20000, liquidity_usd: 50000, last_updated: new Date().toISOString(), source_url: "", confidence: "high" },
    ],
    best_bid_venue: "hydrex_base", best_ask_venue: "osmosis", spread_pct: 0,
    weighted_price_usd: 0.04, total_liquidity_usd: 150000,
    arbitrage_opportunity: null,
    bridge_flow: { signal: "neutral", net_regen_24h: 0, net_usd_24h: 0, largest_tx: null, tx_count_24h: 0 },
    ...overrides,
  };
}

function makeSignal(overrides: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: "test-signal", version: "1.0", generated_at: new Date().toISOString(),
    signal_class: "ACCUMULATION", direction: "long", conviction: "B", token: "REGEN",
    entry_venue: "hydrex_base", entry_price_usd: 0.04, target_price_usd: 0.044,
    stop_loss_usd: 0.037, recommended_size_usd: 50, max_size_usd: 5000,
    time_horizon: "24h", expiry_at: new Date(Date.now() + 86400000).toISOString(),
    rationale: [], contributing_signals: [], risk_factors: [],
    venue_context: { best_price_venue: "a", worst_price_venue: "b", cross_chain_spread_pct: 0, hydrex_apr: 0, hydrex_hours_to_epoch: 168, hydrex_vote_trend: "stable", bridge_flow_signal: "neutral", total_liquidity_usd: 150000 },
    invalidated: false, ...overrides,
  } as TradingSignal;
}

describe("AccumulationStrategy", () => {
  let tmpDir: string;
  let adapter: BankrAdapter;
  let strategy: AccumulationStrategy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "accum-"));
    process.env.EXECUTION_ENABLED = "true";
    process.env.DAILY_BUY_CAP_USD = "100";
    process.env.SINGLE_ORDER_MAX_USD = "50";
    process.env.ACCUMULATION_PRICE_CAP_USD = "0.05";
    process.env.ACCUMULATION_MIN_TVL_USD = "10000";
    process.env.ACCUMULATION_INTERVAL_HOURS = "0"; // disable DCA interval for tests
    adapter = new BankrAdapter(tmpDir, mockLogger());
    strategy = new AccumulationStrategy(adapter, tmpDir, mockLogger());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.EXECUTION_ENABLED;
    delete process.env.DAILY_BUY_CAP_USD;
    delete process.env.SINGLE_ORDER_MAX_USD;
    delete process.env.ACCUMULATION_PRICE_CAP_USD;
    delete process.env.ACCUMULATION_MIN_TVL_USD;
    delete process.env.ACCUMULATION_INTERVAL_HOURS;
  });

  it("returns null when no long signal", async () => {
    const order = await strategy.run(makeSnapshot(), makeSignal({ direction: "short", signal_class: "MOMENTUM_SHORT" }));
    expect(order).toBeNull();
  });

  it("returns null when price above cap", async () => {
    const order = await strategy.run(makeSnapshot({ weighted_price_usd: 0.06 }), makeSignal());
    expect(order).toBeNull();
  });

  it("returns null when EXIT signal", async () => {
    const order = await strategy.run(makeSnapshot(), makeSignal({ signal_class: "EXIT", direction: "exit" }));
    expect(order).toBeNull();
  });

  it("sizes conviction A = base * 2", async () => {
    const order = await strategy.run(makeSnapshot(), makeSignal({ conviction: "A" }));
    expect(order).not.toBeNull();
    // base_size = 100/24 ≈ 4.17, * 2 = 8.33
    expect(order!.amount_usd).toBeGreaterThan(4);
    expect(order!.amount_usd).toBeLessThanOrEqual(50);
  });

  it("EPOCH_PLAY sizes = base * 3", async () => {
    const order = await strategy.run(makeSnapshot(), makeSignal({ signal_class: "EPOCH_PLAY", conviction: "B" }));
    expect(order).not.toBeNull();
    // base * 3 = ~12.5
    expect(order!.amount_usd).toBeGreaterThan(8);
  });

  it("caps at SINGLE_ORDER_MAX_USD", async () => {
    process.env.DAILY_BUY_CAP_USD = "10000"; // very high cap
    const freshAdapter = new BankrAdapter(tmpDir, mockLogger());
    const freshStrategy = new AccumulationStrategy(freshAdapter, tmpDir, mockLogger());
    const order = await freshStrategy.run(makeSnapshot(), makeSignal({ signal_class: "EPOCH_PLAY", conviction: "A" }));
    expect(order).not.toBeNull();
    expect(order!.amount_usd).toBeLessThanOrEqual(50);
  });

  it("returns null when TVL below minimum", async () => {
    const snap = makeSnapshot();
    snap.venues[0].liquidity_usd = 5000; // below 10000 min
    const order = await strategy.run(snap, makeSignal());
    expect(order).toBeNull();
  });
});
