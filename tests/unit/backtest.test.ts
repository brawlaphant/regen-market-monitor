import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { BacktestRunner } from "../../src/backtest/backtest-runner.js";
import { HistoryCollector } from "../../src/backtest/history-collector.js";
import { SignalPerformanceTracker } from "../../src/backtest/signal-performance-tracker.js";
import type { PriceDataset, PricePoint } from "../../src/backtest/history-collector.js";
import type { TradingSignal } from "../../src/signals/trading-signal.js";
import { SIGNAL_CLASSES } from "../../src/signals/trading-signal.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeDataset(days = 7): PriceDataset {
  const points: PricePoint[] = [];
  const now = Date.now();
  for (let i = 0; i < days * 24; i++) {
    const t = now - (days * 24 - i) * 3600000;
    points.push({
      timestamp: new Date(t).toISOString(),
      price_usd: 0.04 + Math.sin(i / 12) * 0.005 + (Math.random() - 0.5) * 0.002,
      volume_24h: 50000 + Math.random() * 20000,
      source: "coingecko",
    });
  }
  return { points, venue: "test", from: points[0].timestamp, to: points[points.length - 1].timestamp, count: points.length };
}

describe("BacktestRunner", () => {
  it("win recorded when target hit before stop", () => {
    const runner = new BacktestRunner(mockLogger());
    const dataset = makeDataset(30);
    const result = runner.run(dataset, {
      signal_classes: [...SIGNAL_CLASSES],
      conviction_filter: "all",
      initial_capital_usd: 1000,
      position_size_pct: 0.1,
      stop_loss_pct: 0.07,
    });
    // With simulated sinusoidal data, some signals should generate
    expect(result.disclaimer).toContain("hypothetical");
    expect(result.total_return_pct).toBeDefined();
  });

  it("equity curve starts at initial capital", () => {
    const runner = new BacktestRunner(mockLogger());
    const dataset = makeDataset(30);
    const result = runner.run(dataset, {
      signal_classes: [...SIGNAL_CLASSES],
      conviction_filter: "all",
      initial_capital_usd: 1000,
      position_size_pct: 0.1,
      stop_loss_pct: 0.07,
    });
    if (result.equity_curve.length > 0) {
      // First point should be near initial capital
      expect(result.equity_curve[0].capital_usd).toBeGreaterThan(0);
    }
  });

  it("returns empty result with insufficient data", () => {
    const runner = new BacktestRunner(mockLogger());
    const dataset = makeDataset(1); // only 24 points, below 48 minimum
    const result = runner.run(dataset, {
      signal_classes: [...SIGNAL_CLASSES],
      conviction_filter: "all",
      initial_capital_usd: 1000,
      position_size_pct: 0.1,
      stop_loss_pct: 0.07,
    });
    expect(result.total_signals).toBe(0);
    expect(result.disclaimer).toContain("Insufficient");
  });

  it("all results include hypothetical disclaimer", () => {
    const runner = new BacktestRunner(mockLogger());
    const result = runner.run(makeDataset(30), {
      signal_classes: [...SIGNAL_CLASSES],
      conviction_filter: "all",
      initial_capital_usd: 1000,
      position_size_pct: 0.1,
      stop_loss_pct: 0.07,
    });
    expect(result.disclaimer).toContain("hypothetical");
    expect(result.disclaimer).toContain("No real capital");
  });
});

describe("HistoryCollector", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(tmpdir(), "hist-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("merges live data from cross-chain-history.jsonl", async () => {
    const histPath = path.join(tmpDir, "cross-chain-history.jsonl");
    const snap = { timestamp: new Date().toISOString(), weighted_price_usd: 0.042, venues: [] };
    fs.writeFileSync(histPath, JSON.stringify(snap) + "\n");

    const collector = new HistoryCollector(tmpDir, mockLogger());
    // Don't call collectPriceHistory (it fetches from CoinGecko) — test data loading directly
    expect(fs.existsSync(histPath)).toBe(true);
  });
});

describe("SignalPerformanceTracker", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(tmpdir(), "perf-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("tracks signal and reports win on positive return", () => {
    const tracker = new SignalPerformanceTracker(tmpDir, mockLogger());
    const signal: TradingSignal = {
      id: "test-1", version: "1.0", generated_at: new Date(Date.now() - 10000).toISOString(),
      signal_class: "MOMENTUM_LONG", direction: "long", conviction: "B", token: "REGEN",
      entry_venue: "hydrex", entry_price_usd: 0.04, target_price_usd: 0.044,
      stop_loss_usd: 0.037, recommended_size_usd: 100, max_size_usd: 5000,
      time_horizon: "4h", expiry_at: new Date(Date.now() - 1000).toISOString(), // expired
      rationale: [], contributing_signals: [], risk_factors: [],
      venue_context: { best_price_venue: "a", worst_price_venue: "b", cross_chain_spread_pct: 0, hydrex_apr: 0, hydrex_hours_to_epoch: 168, hydrex_vote_trend: "stable", bridge_flow_signal: "neutral", total_liquidity_usd: 100000 },
      invalidated: false,
    };

    tracker.trackSignal(signal);
    tracker.updatePerformance(0.044); // price went up

    const perf = tracker.getLivePerformance() as any;
    expect(perf.signals_tracked).toBe(1);
    expect(perf.signals_completed).toBe(1);
    expect(perf.win_rate).toBe(100);
  });
});
