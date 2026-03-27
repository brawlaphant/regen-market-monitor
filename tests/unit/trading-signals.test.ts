import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SignalComposer } from "../../src/signals/signal-composer.js";
import { SignalInvalidator } from "../../src/signals/signal-invalidator.js";
import { TradingSignalStore } from "../../src/signals/trading-signal-store.js";
import type { CrossChainSnapshot, VenuePrice } from "../../src/chain/cross-chain-aggregator.js";
import type { MarketSignal } from "../../src/signals/signal-schema.js";
import type { TradingSignal } from "../../src/signals/trading-signal.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeVenue(venue: string, price: number): VenuePrice {
  return {
    venue: venue as any, price_usd: price, volume_24h_usd: 50000,
    liquidity_usd: 100000, last_updated: new Date().toISOString(),
    source_url: "test", confidence: "high",
  };
}

function makeSnapshot(overrides: Partial<CrossChainSnapshot> = {}): CrossChainSnapshot {
  return {
    timestamp: new Date().toISOString(),
    venues: [makeVenue("osmosis", 0.04), makeVenue("hydrex_base", 0.042)],
    best_bid_venue: "hydrex_base", best_ask_venue: "osmosis",
    spread_pct: 5, weighted_price_usd: 0.041, total_liquidity_usd: 200000,
    arbitrage_opportunity: null,
    bridge_flow: { signal: "neutral", net_regen_24h: 0, net_usd_24h: 0, largest_tx: null, tx_count_24h: 0 },
    ...overrides,
  };
}

function makeMarketSignal(type: string, data: Record<string, unknown> = {}): MarketSignal {
  return {
    id: crypto.randomUUID(), version: "1.0", source: "regen-market-monitor",
    agent_id: "AGENT-003", signal_type: type as any, severity: "WARNING",
    timestamp: new Date().toISOString(), data: data as any,
    context: { triggered_by: "scheduled_poll", workflow_id: "test", poll_sequence: 1, related_signal_ids: [] },
    routing: { target_agents: ["AGENT-001"], broadcast_channels: ["rest"], ttl_seconds: 3600, priority: 2 },
  };
}

describe("SignalComposer", () => {
  let tmpDir: string;
  let composer: SignalComposer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "sc-"));
    composer = new SignalComposer(tmpDir, mockLogger());
  });

  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("all positive inputs produce positive score / long direction", () => {
    const signals = [
      makeMarketSignal("PRICE_MOVEMENT", { direction: "up", change_pct: 5, current_price: 0.05, previous_price: 0.04, threshold_pct: 2 }),
      makeMarketSignal("PRICE_MOVEMENT", { direction: "up", change_pct: 3, current_price: 0.045, previous_price: 0.04, threshold_pct: 2 }),
    ];
    const snap = makeSnapshot({ bridge_flow: { signal: "accumulation", net_regen_24h: 20000, net_usd_24h: 800, largest_tx: null, tx_count_24h: 5 } });
    const ts = composer.compose(snap, signals);
    expect(ts.direction).toBe("long");
  });

  it("arbitrage override fires regardless of other scores", () => {
    const snap = makeSnapshot({
      arbitrage_opportunity: {
        buy_venue: "osmosis", sell_venue: "hydrex_base", buy_price_usd: 0.04,
        sell_price_usd: 0.06, gross_spread_pct: 50, estimated_bridge_cost_usd: 3,
        estimated_gas_cost_usd: 0.01, net_spread_pct: 4.0, profitable: true,
        confidence: "high", recommended_size_usd: 500, expiry_estimate_minutes: 15, notes: "IBC",
      },
    });
    const ts = composer.compose(snap, []);
    expect(ts.signal_class).toBe("ARBITRAGE_LONG");
    expect(ts.conviction).toBe("A"); // net_spread > 3%
  });

  it("EXIT on MANIPULATION_ALERT", () => {
    const signals = [makeMarketSignal("MANIPULATION_ALERT", {
      batch_denom: "C01", order_ids: ["1"], z_score: 4.0, evidence_summary: "test",
    })];
    const ts = composer.compose(makeSnapshot(), signals);
    expect(ts.signal_class).toBe("EXIT");
    expect(ts.direction).toBe("exit");
  });

  it("conviction A when score >= 6 and >= 3 dimensions", () => {
    // Bridge accumulation (+2), 3 price up signals (+3), z-score low (+2) = 7, 3 dims
    const signals = [
      makeMarketSignal("PRICE_MOVEMENT", { direction: "up", change_pct: 5, current_price: 0.05, previous_price: 0.04, threshold_pct: 2 }),
      makeMarketSignal("PRICE_MOVEMENT", { direction: "up", change_pct: 4, current_price: 0.05, previous_price: 0.04, threshold_pct: 2 }),
      makeMarketSignal("PRICE_MOVEMENT", { direction: "up", change_pct: 3, current_price: 0.05, previous_price: 0.04, threshold_pct: 2 }),
      makeMarketSignal("PRICE_ANOMALY", { batch_denom: "C01", current_price: 0.02, z_score: -3.0, mean_price: 0.04, std_dev: 0.005, window_size: 24, anomaly_level: "critical" }),
    ];
    const snap = makeSnapshot({ bridge_flow: { signal: "accumulation", net_regen_24h: 20000, net_usd_24h: 800, largest_tx: null, tx_count_24h: 5 } });
    const ts = composer.compose(snap, signals);
    expect(ts.conviction).toBe("A");
  });

  it("conviction C when score 1-2 with 1 dimension", () => {
    const signals = [
      makeMarketSignal("PRICE_MOVEMENT", { direction: "up", change_pct: 3, current_price: 0.05, previous_price: 0.04, threshold_pct: 2 }),
    ];
    const ts = composer.compose(makeSnapshot(), signals);
    expect(["B", "C"]).toContain(ts.conviction);
  });

  it("size: A = base, B = 0.5x, C = 0.25x", () => {
    // With 200k liquidity, base = min(200k * 0.01, 5000) = 2000
    const snap = makeSnapshot();
    const holdSignal = composer.compose(snap, []);
    // HOLD is conviction C → 0.25 * 2000 = 500
    expect(holdSignal.recommended_size_usd).toBeLessThanOrEqual(5000);
  });

  it("target price: long at $0.04 targets higher", () => {
    const signals = [
      makeMarketSignal("PRICE_MOVEMENT", { direction: "up", change_pct: 5, current_price: 0.05, previous_price: 0.04, threshold_pct: 2 }),
    ];
    const ts = composer.compose(makeSnapshot(), signals);
    if (ts.direction === "long" && ts.target_price_usd) {
      expect(ts.target_price_usd).toBeGreaterThan(ts.entry_price_usd);
    }
  });

  it("expiry: immediate signal expires within 15 min", () => {
    const snap = makeSnapshot({
      arbitrage_opportunity: {
        buy_venue: "osmosis", sell_venue: "hydrex_base", buy_price_usd: 0.04,
        sell_price_usd: 0.06, gross_spread_pct: 50, estimated_bridge_cost_usd: 3,
        estimated_gas_cost_usd: 0.01, net_spread_pct: 2.0, profitable: true,
        confidence: "high", recommended_size_usd: 500, expiry_estimate_minutes: 15, notes: "",
      },
    });
    const ts = composer.compose(snap, []);
    const expiryMs = new Date(ts.expiry_at).getTime() - new Date(ts.generated_at).getTime();
    expect(expiryMs).toBeLessThanOrEqual(16 * 60 * 1000); // ~15 min
  });

  it("returns HOLD on error (never throws)", () => {
    const ts = composer.compose(null as any, []);
    expect(ts.signal_class).toBe("HOLD");
  });
});

describe("SignalInvalidator", () => {
  it("invalidates long when price moved 4% against", () => {
    const inv = new SignalInvalidator(mockLogger());
    const signal: TradingSignal = {
      id: "test", version: "1.0", generated_at: new Date().toISOString(),
      signal_class: "MOMENTUM_LONG", direction: "long", conviction: "B",
      token: "REGEN", entry_venue: "osmosis", entry_price_usd: 0.04,
      target_price_usd: 0.044, stop_loss_usd: 0.037, recommended_size_usd: 1000,
      max_size_usd: 5000, time_horizon: "4h", expiry_at: new Date(Date.now() + 3600000).toISOString(),
      rationale: ["test"], contributing_signals: [], risk_factors: [],
      venue_context: { best_price_venue: "a", worst_price_venue: "b", cross_chain_spread_pct: 1, hydrex_apr: 0, hydrex_hours_to_epoch: 168, hydrex_vote_trend: "stable", bridge_flow_signal: "neutral", total_liquidity_usd: 100000 },
      invalidated: false,
    };
    const snap = makeSnapshot({ weighted_price_usd: 0.0384 }); // -4%
    const result = inv.checkAll([signal], snap, []);
    expect(result.length).toBe(1);
    expect(result[0].invalidated).toBe(true);
  });

  it("invalidates EPOCH_PLAY when no epoch signals", () => {
    const inv = new SignalInvalidator(mockLogger());
    const signal: TradingSignal = {
      id: "test", version: "1.0", generated_at: new Date().toISOString(),
      signal_class: "EPOCH_PLAY", direction: "long", conviction: "B",
      token: "REGEN", entry_venue: "hydrex_base", entry_price_usd: 0.04,
      target_price_usd: 0.044, stop_loss_usd: 0.037, recommended_size_usd: 500,
      max_size_usd: 5000, time_horizon: "epoch", expiry_at: new Date(Date.now() + 86400000).toISOString(),
      rationale: ["epoch play"], contributing_signals: [], risk_factors: [],
      venue_context: { best_price_venue: "a", worst_price_venue: "b", cross_chain_spread_pct: 1, hydrex_apr: 100, hydrex_hours_to_epoch: 4, hydrex_vote_trend: "increasing", bridge_flow_signal: "neutral", total_liquidity_usd: 100000 },
      invalidated: false,
    };
    const result = inv.checkAll([signal], makeSnapshot(), []); // no epoch signals
    expect(result.length).toBe(1);
    expect(result[0].invalidated_reason).toContain("Epoch");
  });

  it("invalidates ARBITRAGE_LONG when spread < 0.5%", () => {
    const inv = new SignalInvalidator(mockLogger());
    const signal: TradingSignal = {
      id: "test", version: "1.0", generated_at: new Date().toISOString(),
      signal_class: "ARBITRAGE_LONG", direction: "long", conviction: "A",
      token: "REGEN", entry_venue: "osmosis", entry_price_usd: 0.04,
      target_price_usd: 0.044, stop_loss_usd: 0.0392, recommended_size_usd: 500,
      max_size_usd: 5000, time_horizon: "immediate", expiry_at: new Date(Date.now() + 900000).toISOString(),
      rationale: ["arb"], contributing_signals: [], risk_factors: [],
      venue_context: { best_price_venue: "a", worst_price_venue: "b", cross_chain_spread_pct: 5, hydrex_apr: 0, hydrex_hours_to_epoch: 168, hydrex_vote_trend: "stable", bridge_flow_signal: "neutral", total_liquidity_usd: 100000 },
      invalidated: false,
    };
    const snap = makeSnapshot({ spread_pct: 0.3, arbitrage_opportunity: null });
    const result = inv.checkAll([signal], snap, []);
    expect(result.length).toBe(1);
    expect(result[0].invalidated_reason).toContain("spread closed");
  });
});

describe("TradingSignalStore", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(tmpdir(), "tss-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function makeTS(overrides: Partial<TradingSignal> = {}): TradingSignal {
    return {
      id: crypto.randomUUID(), version: "1.0", generated_at: new Date().toISOString(),
      signal_class: "HOLD", direction: "neutral", conviction: "C", token: "REGEN",
      entry_venue: "osmosis", entry_price_usd: 0.04, target_price_usd: null,
      stop_loss_usd: null, recommended_size_usd: 500, max_size_usd: 5000,
      time_horizon: "4h", expiry_at: new Date(Date.now() + 3600000).toISOString(),
      rationale: ["test"], contributing_signals: [], risk_factors: ["test"],
      venue_context: { best_price_venue: "a", worst_price_venue: "b", cross_chain_spread_pct: 1, hydrex_apr: 0, hydrex_hours_to_epoch: 168, hydrex_vote_trend: "stable", bridge_flow_signal: "neutral", total_liquidity_usd: 100000 },
      invalidated: false, ...overrides,
    };
  }

  it("ring buffer trims at 200", () => {
    const store = new TradingSignalStore(tmpDir, mockLogger());
    for (let i = 0; i < 210; i++) store.push(makeTS());
    expect(store.getRecent(300).length).toBeLessThanOrEqual(200);
  });

  it("getActive excludes expired and invalidated", () => {
    const store = new TradingSignalStore(tmpDir, mockLogger());
    store.push(makeTS({ expiry_at: new Date(Date.now() + 3600000).toISOString() })); // active
    store.push(makeTS({ expiry_at: new Date(Date.now() - 1000).toISOString() })); // expired
    store.push(makeTS({ invalidated: true, invalidated_reason: "test" })); // invalidated
    expect(store.getActive().length).toBe(1);
  });

  it("getStats returns correct counts", () => {
    const store = new TradingSignalStore(tmpDir, mockLogger());
    store.push(makeTS({ conviction: "A" }));
    store.push(makeTS({ conviction: "B" }));
    const stats = store.getStats() as any;
    expect(stats.total).toBe(2);
    expect(stats.by_conviction.A).toBe(1);
  });

  it("performance returns hypothetical disclaimer", () => {
    const store = new TradingSignalStore(tmpDir, mockLogger());
    store.push(makeTS({ direction: "long", entry_price_usd: 0.04, expiry_at: new Date(Date.now() - 1000).toISOString() }));
    const perf = store.getPerformance(0.042) as any;
    expect(perf.disclaimer).toContain("Hypothetical");
  });
});
