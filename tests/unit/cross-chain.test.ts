import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CrossChainAggregator } from "../../src/chain/cross-chain-aggregator.js";
import { ArbitrageDetector } from "../../src/chain/arbitrage-detector.js";
import { AxelarClient } from "../../src/chain/venues/axelar-client.js";
import { VenueDiscovery } from "../../src/chain/venue-discovery.js";
import type { CrossChainSnapshot, VenuePrice, ArbitrageSignal } from "../../src/chain/cross-chain-aggregator.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeVenue(venue: string, price: number, overrides: Partial<VenuePrice> = {}): VenuePrice {
  return {
    venue: venue as any,
    price_usd: price,
    volume_24h_usd: 50000,
    liquidity_usd: 100000,
    last_updated: new Date().toISOString(),
    source_url: "https://test",
    confidence: "high",
    ...overrides,
  };
}

function makeSnapshot(venues: VenuePrice[]): CrossChainSnapshot {
  const sorted = [...venues].sort((a, b) => a.price_usd - b.price_usd);
  const spread = sorted.length >= 2
    ? ((sorted[sorted.length - 1].price_usd - sorted[0].price_usd) / sorted[0].price_usd) * 100
    : 0;
  return {
    timestamp: new Date().toISOString(),
    venues,
    best_bid_venue: sorted[sorted.length - 1]?.venue || "none",
    best_ask_venue: sorted[0]?.venue || "none",
    spread_pct: spread,
    weighted_price_usd: venues[0]?.price_usd || 0,
    total_liquidity_usd: venues.reduce((s, v) => s + v.liquidity_usd, 0),
    arbitrage_opportunity: null,
    bridge_flow: { signal: "neutral", net_regen_24h: 0, net_usd_24h: 0, largest_tx: null, tx_count_24h: 0 },
  };
}

describe("CrossChainAggregator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "cc-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns snapshot with minimum 2 venues even when others fail", async () => {
    const agg = new CrossChainAggregator(tmpDir, mockLogger());
    // Mock the internal venue fetchers to return known data
    (agg as any).fetchOsmosis = vi.fn().mockResolvedValue(makeVenue("osmosis", 0.042));
    (agg as any).fetchAerodrome = vi.fn().mockResolvedValue(null); // fail
    (agg as any).fetchCoinGecko = vi.fn().mockResolvedValue(makeVenue("coingecko", 0.041));
    (agg as any).axelar = { getFlowSnapshot: vi.fn().mockResolvedValue({ signal: "neutral", net_regen_24h: 0, net_usd_24h: 0, largest_tx: null, tx_count_24h: 0 }) };

    const snap = await agg.fetchAll();
    expect(snap.venues.length).toBeGreaterThanOrEqual(2);
    expect(snap.weighted_price_usd).toBeGreaterThan(0);
  });

  it("persists snapshot to disk", async () => {
    const agg = new CrossChainAggregator(tmpDir, mockLogger());
    (agg as any).fetchOsmosis = vi.fn().mockResolvedValue(makeVenue("osmosis", 0.04));
    (agg as any).fetchAerodrome = vi.fn().mockResolvedValue(null);
    (agg as any).fetchCoinGecko = vi.fn().mockResolvedValue(makeVenue("coingecko", 0.04));
    (agg as any).axelar = { getFlowSnapshot: vi.fn().mockResolvedValue({ signal: "neutral", net_regen_24h: 0, net_usd_24h: 0, largest_tx: null, tx_count_24h: 0 }) };

    await agg.fetchAll();
    expect(fs.existsSync(path.join(tmpDir, "cross-chain-snapshot.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "cross-chain-history.jsonl"))).toBe(true);
  });
});

describe("ArbitrageDetector", () => {
  let detector: ArbitrageDetector;

  beforeEach(() => {
    detector = new ArbitrageDetector(mockLogger());
  });

  it("identifies profitable opportunity with spread > threshold", () => {
    const snap = makeSnapshot([
      makeVenue("osmosis", 0.040),
      makeVenue("aerodrome_base", 0.048), // 20% spread
    ]);
    const arb = detector.detectArbitrage(snap);
    expect(arb).not.toBeNull();
    expect(arb!.gross_spread_pct).toBeGreaterThan(2);
    expect(arb!.buy_venue).toBe("osmosis");
    expect(arb!.sell_venue).toBe("aerodrome_base");
  });

  it("does not flag opportunity with net spread below min after costs", () => {
    // Very small spread that gets eaten by fees
    const snap = makeSnapshot([
      makeVenue("osmosis", 0.0400),
      makeVenue("aerodrome_base", 0.0408), // 2% gross, but fees eat it
    ]);
    const arb = detector.detectArbitrage(snap);
    if (arb) {
      expect(arb.profitable).toBe(false);
    }
  });

  it("never flags confidence LOW opportunities as alerts", () => {
    const snap = makeSnapshot([
      makeVenue("osmosis", 0.040, { confidence: "low", last_updated: new Date(Date.now() - 20 * 60000).toISOString() }),
      makeVenue("aerodrome_base", 0.060, { confidence: "low", last_updated: new Date(Date.now() - 20 * 60000).toISOString() }),
    ]);
    const arb = detector.detectArbitrage(snap);
    if (arb) {
      expect(arb.confidence).toBe("low");
      // The scheduler should check confidence !== "low" before alerting
    }
  });

  it("caps recommended_size at liquidity/10", () => {
    const snap = makeSnapshot([
      makeVenue("osmosis", 0.040, { liquidity_usd: 1000 }),
      makeVenue("aerodrome_base", 0.060, { liquidity_usd: 2000 }),
    ]);
    const arb = detector.detectArbitrage(snap);
    expect(arb).not.toBeNull();
    expect(arb!.recommended_size_usd).toBeLessThanOrEqual(1000 / 10); // min liquidity / 10
  });

  it("returns null when fewer than 2 venues", () => {
    const snap = makeSnapshot([makeVenue("osmosis", 0.04)]);
    expect(detector.detectArbitrage(snap)).toBeNull();
  });
});

describe("AxelarClient", () => {
  it("classifies net outflow > threshold as distribution", () => {
    const client = new AxelarClient(mockLogger());
    expect(client.computeFlowSignal({ net_regen: -15000, net_usd: -600, inflows: 1000, outflows: 16000 })).toBe("distribution");
  });

  it("classifies net inflow > threshold as accumulation", () => {
    const client = new AxelarClient(mockLogger());
    expect(client.computeFlowSignal({ net_regen: 15000, net_usd: 600, inflows: 16000, outflows: 1000 })).toBe("accumulation");
  });

  it("classifies small flows as neutral", () => {
    const client = new AxelarClient(mockLogger());
    expect(client.computeFlowSignal({ net_regen: 500, net_usd: 20, inflows: 1000, outflows: 500 })).toBe("neutral");
  });
});

describe("VenueDiscovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "vd-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses cache when not stale", async () => {
    const cache = {
      osmosis_pool_id: "1",
      regen_ibc_denom_osmosis: "ibc/test",
      regen_contract_base: "0xtest",
      regen_contract_celo: "",
      last_discovered: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmpDir, "venue-contracts.json"), JSON.stringify(cache));

    const disc = new VenueDiscovery(tmpDir, mockLogger());
    const result = await disc.refreshIfStale();
    expect(result.osmosis_pool_id).toBe("1");
    expect(result.regen_contract_base).toBe("0xtest");
  });

  it("continues with cached value when discovery fails", async () => {
    const cache = {
      osmosis_pool_id: "cached-id",
      regen_ibc_denom_osmosis: "",
      regen_contract_base: "0xcached",
      regen_contract_celo: "",
      last_discovered: new Date(Date.now() - 30 * 86400000).toISOString(), // 30 days ago = stale
    };
    fs.writeFileSync(path.join(tmpDir, "venue-contracts.json"), JSON.stringify(cache));

    // Mock fetch to fail
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    const disc = new VenueDiscovery(tmpDir, mockLogger());
    const result = await disc.refreshIfStale();
    // Should fall back to cached values
    expect(result.osmosis_pool_id).toBe("cached-id");

    vi.unstubAllGlobals();
  });
});
