import { describe, it, expect } from "vitest";
import {
  computeBetSize,
  dedupeAndRank,
} from "../../src/venues/polymarket/strategies.js";
import { categorizeMarket } from "../../src/venues/polymarket/types.js";
import type { ScoredMarket } from "../../src/venues/polymarket/types.js";

describe("Polymarket strategies", () => {
  describe("computeBetSize", () => {
    it("returns minBet at threshold boundary", () => {
      const size = computeBetSize(0.15, 0.15, 2, 8);
      expect(size).toBe(2);
    });

    it("returns maxBet at large divergence", () => {
      const size = computeBetSize(0.50, 0.15, 2, 8);
      expect(size).toBe(8);
    });

    it("interpolates between min and max", () => {
      const size = computeBetSize(0.30, 0.15, 2, 8);
      expect(size).toBeGreaterThan(2);
      expect(size).toBeLessThan(8);
    });

    it("works with negative divergence (absolute value)", () => {
      const size = computeBetSize(-0.25, 0.15, 3, 10);
      expect(size).toBeGreaterThan(3);
    });
  });

  describe("categorizeMarket", () => {
    it("detects geopolitics", () => {
      expect(categorizeMarket("Will NATO expand to include Ukraine?")).toBe("geopolitics");
    });

    it("detects AI", () => {
      expect(categorizeMarket("Will OpenAI release GPT-5 before July?")).toBe("ai");
    });

    it("detects climate", () => {
      expect(categorizeMarket("Will global temperature rise 1.5C by 2030?")).toBe("climate");
    });

    it("detects crypto", () => {
      expect(categorizeMarket("Will Bitcoin ETF be approved?")).toBe("crypto");
    });

    it("returns null for unmatched", () => {
      expect(categorizeMarket("Will the Lakers win the championship?")).toBeNull();
    });
  });

  describe("dedupeAndRank", () => {
    it("deduplicates by slug, keeping strongest edge", () => {
      const signals: ScoredMarket[] = [
        { question: "Q1", slug: "abc", crowdYes: 0.5, aiYes: 0.7, divergence: 0.20, direction: "BUY_YES", betSize: 5, liquidity: 100000, source: "spray" },
        { question: "Q1", slug: "abc", crowdYes: 0.5, aiYes: 0.8, divergence: 0.30, direction: "BUY_YES", betSize: 8, liquidity: 100000, source: "worldview" },
        { question: "Q2", slug: "def", crowdYes: 0.9, aiYes: 0.7, divergence: -0.20, direction: "BUY_NO", betSize: 5, liquidity: 50000, source: "contrarian" },
      ];

      const ranked = dedupeAndRank(signals);
      expect(ranked).toHaveLength(2);
      // abc should keep the stronger 0.30 divergence
      expect(ranked[0].slug).toBe("abc");
      expect(ranked[0].divergence).toBe(0.30);
    });

    it("sorts by absolute edge descending", () => {
      const signals: ScoredMarket[] = [
        { question: "Q1", slug: "a", crowdYes: 0.5, aiYes: 0.6, divergence: 0.10, direction: "BUY_YES", betSize: 2, liquidity: 100000 },
        { question: "Q2", slug: "b", crowdYes: 0.5, aiYes: 0.2, divergence: -0.30, direction: "BUY_NO", betSize: 8, liquidity: 100000 },
        { question: "Q3", slug: "c", crowdYes: 0.5, aiYes: 0.7, divergence: 0.20, direction: "BUY_YES", betSize: 5, liquidity: 100000 },
      ];

      const ranked = dedupeAndRank(signals);
      expect(ranked[0].slug).toBe("b"); // -0.30 abs
      expect(ranked[1].slug).toBe("c"); // 0.20 abs
      expect(ranked[2].slug).toBe("a"); // 0.10 abs
    });

    it("returns empty for empty input", () => {
      expect(dedupeAndRank([])).toHaveLength(0);
    });
  });
});
