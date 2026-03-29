import { describe, it, expect, vi, afterEach } from "vitest";
import { PolymarketClient } from "../../src/venues/polymarket/client.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("PolymarketClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses crowd price from outcomePrices", () => {
    const client = new PolymarketClient(mockLogger());
    const price = client.parseCrowdPrice({
      id: "1", question: "test", outcomePrices: '["0.72","0.28"]',
      volume: "1000000", liquidity: "500000", active: true, closed: false, conditionId: "abc",
    });
    expect(price).toBeCloseTo(0.72, 2);
  });

  it("returns null for missing outcomePrices", () => {
    const client = new PolymarketClient(mockLogger());
    const price = client.parseCrowdPrice({
      id: "1", question: "test", volume: "1000", liquidity: "500",
      active: true, closed: false, conditionId: "abc",
    });
    expect(price).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const client = new PolymarketClient(mockLogger());
    const price = client.parseCrowdPrice({
      id: "1", question: "test", outcomePrices: "not json",
      volume: "1000", liquidity: "500", active: true, closed: false, conditionId: "abc",
    });
    expect(price).toBeNull();
  });

  it("fetches and flattens markets from events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: "evt1", slug: "test-event", title: "Test Event",
          markets: [
            { id: "m1", question: "Q1", outcomePrices: '["0.5","0.5"]', volume: "1000000", liquidity: "500000", active: true, closed: false, conditionId: "c1" },
            { id: "m2", question: "Q2", outcomePrices: '["0.8","0.2"]', volume: "500000", liquidity: "200000", active: true, closed: false, conditionId: "c2" },
            { id: "m3", question: "", outcomePrices: '["0.6","0.4"]', volume: "100000", liquidity: "50000", active: true, closed: false, conditionId: "c3" },
          ],
        },
      ],
    }));

    const client = new PolymarketClient(mockLogger());
    const markets = await client.fetchMarkets(10);
    expect(markets).toHaveLength(3);
    // Empty question should fall back to event title
    expect(markets[2].question).toBe("Test Event");
  });

  it("filters out closed and inactive markets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: "evt1", slug: "s", title: "T",
          markets: [
            { id: "m1", question: "Q1", outcomePrices: '["0.5","0.5"]', volume: "1000", liquidity: "500", active: true, closed: false, conditionId: "c1" },
            { id: "m2", question: "Q2", outcomePrices: '["0.5","0.5"]', volume: "1000", liquidity: "500", active: false, closed: false, conditionId: "c2" },
            { id: "m3", question: "Q3", outcomePrices: '["0.5","0.5"]', volume: "1000", liquidity: "500", active: true, closed: true, conditionId: "c3" },
          ],
        },
      ],
    }));

    const client = new PolymarketClient(mockLogger());
    const markets = await client.fetchMarkets(10);
    expect(markets).toHaveLength(1);
    expect(markets[0].id).toBe("m1");
  });

  it("throws on API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }));

    const client = new PolymarketClient(mockLogger());
    await expect(client.fetchMarkets(10)).rejects.toThrow("Polymarket API 500");
  });
});
