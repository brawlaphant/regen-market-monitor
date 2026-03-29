/**
 * Integration tests for Polymarket strategy functions with mocked scorer.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runSpray,
  runWorldview,
  runContrarian,
  runCloser,
} from "../../src/venues/polymarket/strategies.js";
import { PolymarketClient } from "../../src/venues/polymarket/client.js";
import type { LitcreditScorer } from "../../src/scoring/litcredit-provider.js";
import type { PolymarketMarket } from "../../src/venues/polymarket/types.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeMarket(overrides: Partial<PolymarketMarket> = {}): PolymarketMarket {
  return {
    id: "m1", question: "Will BTC hit $100K?", outcomePrices: '["0.60","0.40"]',
    volume: "5000000", liquidity: "200000", active: true, closed: false,
    conditionId: "cond1", ...overrides,
  };
}

function makeScorer(aiProb: number | null): LitcreditScorer {
  return {
    scoreProbability: vi.fn().mockResolvedValue(aiProb),
    scoreProbabilityWithContext: vi.fn().mockResolvedValue(aiProb),
    generateContext: vi.fn().mockResolvedValue("Some headline context"),
    analyze: vi.fn().mockResolvedValue("Analysis"),
    isConfigured: true,
  } as unknown as LitcreditScorer;
}

describe("runSpray", () => {
  afterEach(() => vi.restoreAllMocks());

  it("produces signal when divergence >= 15%", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.80); // AI=80%, crowd=60%, div=20%
    const signals = await runSpray([makeMarket()], client, scorer);
    expect(signals).toHaveLength(1);
    expect(signals[0].direction).toBe("BUY_YES");
    expect(signals[0].divergence).toBeCloseTo(0.20, 2);
    expect(signals[0].source).toBe("spray");
  });

  it("skips when divergence < 15%", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.65); // AI=65%, crowd=60%, div=5%
    const signals = await runSpray([makeMarket()], client, scorer);
    expect(signals).toHaveLength(0);
  });

  it("produces BUY_NO when AI < crowd", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.40); // AI=40%, crowd=60%, div=-20%
    const signals = await runSpray([makeMarket()], client, scorer);
    expect(signals).toHaveLength(1);
    expect(signals[0].direction).toBe("BUY_NO");
  });

  it("skips when scorer returns null", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(null);
    const signals = await runSpray([makeMarket()], client, scorer);
    expect(signals).toHaveLength(0);
  });

  it("skips markets with null crowd price", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.80);
    const signals = await runSpray([makeMarket({ outcomePrices: undefined })], client, scorer);
    expect(signals).toHaveLength(0);
  });

  it("handles empty markets array", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.80);
    const signals = await runSpray([], client, scorer);
    expect(signals).toHaveLength(0);
  });
});

describe("runWorldview", () => {
  afterEach(() => vi.restoreAllMocks());

  it("only scores categorizable markets", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.85);
    const markets = [
      makeMarket({ question: "Will Bitcoin ETF be approved?", conditionId: "c1" }), // crypto
      makeMarket({ question: "Will Lakers win?", conditionId: "c2" }), // uncategorized
    ];
    const signals = await runWorldview(markets, client, scorer);
    // Only the crypto market should be scored
    expect(scorer.scoreProbabilityWithContext).toHaveBeenCalledTimes(1);
    expect(signals.length).toBeLessThanOrEqual(1);
  });

  it("uses context from generateContext", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.85);
    const markets = [makeMarket({ question: "Will OpenAI release GPT-5?" })];
    await runWorldview(markets, client, scorer);
    expect(scorer.generateContext).toHaveBeenCalled();
    expect(scorer.scoreProbabilityWithContext).toHaveBeenCalled();
  });

  it("requires >= 20% divergence", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.70); // 10% div, below 20% threshold
    const markets = [makeMarket({ question: "Will Bitcoin hit $200K?" })];
    const signals = await runWorldview(markets, client, scorer);
    expect(signals).toHaveLength(0);
  });
});

describe("runContrarian", () => {
  afterEach(() => vi.restoreAllMocks());

  it("targets markets with >85% crowd confidence", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.70); // AI much less confident
    const markets = [
      makeMarket({ outcomePrices: '["0.92","0.08"]', conditionId: "c1" }),
      makeMarket({ outcomePrices: '["0.50","0.50"]', conditionId: "c2" }), // not extreme
    ];
    const signals = await runContrarian(markets, client, scorer);
    // Only the 92% market should be considered
    expect(signals.length).toBeLessThanOrEqual(1);
  });

  it("fades overconfidence — produces BUY_NO on high YES", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.70); // AI=70% vs crowd=90%
    const markets = [makeMarket({ outcomePrices: '["0.90","0.10"]' })];
    const signals = await runContrarian(markets, client, scorer);
    expect(signals).toHaveLength(1);
    expect(signals[0].direction).toBe("BUY_NO");
  });

  it("skips when AI agrees with crowd", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.88); // AI close to crowd 90%
    const markets = [makeMarket({ outcomePrices: '["0.90","0.10"]' })];
    const signals = await runContrarian(markets, client, scorer);
    expect(signals).toHaveLength(0);
  });
});

describe("runCloser", () => {
  afterEach(() => vi.restoreAllMocks());

  it("targets markets ending within 48h with high liquidity", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.90); // 30% div from 60% crowd
    const endingSoon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const markets = [
      makeMarket({ endDate: endingSoon, liquidity: "200000", conditionId: "c1" }),
      makeMarket({ endDate: undefined, conditionId: "c2" }), // no end date
      makeMarket({ endDate: endingSoon, liquidity: "1000", conditionId: "c3" }), // low liq
    ];
    const signals = await runCloser(markets, client, scorer);
    expect(signals.length).toBeLessThanOrEqual(1);
  });

  it("skips markets already resolved (end date in past)", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.90);
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const signals = await runCloser([makeMarket({ endDate: past, liquidity: "200000" })], client, scorer);
    expect(signals).toHaveLength(0);
  });

  it("requires >= 25% divergence", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.70); // 10% div
    const endingSoon = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const signals = await runCloser([makeMarket({ endDate: endingSoon, liquidity: "200000" })], client, scorer);
    expect(signals).toHaveLength(0);
  });

  it("handles invalid end date format", async () => {
    const client = new PolymarketClient(mockLogger());
    const scorer = makeScorer(0.90);
    const signals = await runCloser([makeMarket({ endDate: "not-a-date", liquidity: "200000" })], client, scorer);
    expect(signals).toHaveLength(0);
  });
});
