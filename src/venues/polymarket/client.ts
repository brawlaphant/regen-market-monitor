/**
 * Polymarket API Client
 *
 * Fetches active markets from the Gamma API and parses crowd prices.
 */

import type { Logger } from "../../logger.js";
import type { PolymarketEvent, PolymarketMarket } from "./types.js";

const GAMMA_API = "https://gamma-api.polymarket.com";

export class PolymarketClient {
  private logger: Logger;
  private timeoutMs: number;

  constructor(logger: Logger, timeoutMs = 15_000) {
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  /** Fetch top active markets by volume */
  async fetchMarkets(limit: number, extraParams = ""): Promise<PolymarketMarket[]> {
    const url = `${GAMMA_API}/events?closed=false&active=true&limit=${limit}&order=volume&ascending=false${extraParams}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Polymarket API ${res.status}: ${body.substring(0, 100)}`);
    }

    const raw = await res.json();
    const events = Array.isArray(raw) ? (raw as PolymarketEvent[]) : [];
    const markets: PolymarketMarket[] = [];

    for (const event of events) {
      if (!event.markets) continue;
      for (const m of event.markets) {
        if (!m.active || m.closed) continue;
        if (m.outcomePrices) {
          markets.push({ ...m, question: m.question || event.title });
        }
      }
      if (markets.length >= limit) break;
    }

    this.logger.debug({ count: markets.length }, "Polymarket markets fetched");
    return markets.slice(0, limit);
  }

  /** Parse the YES crowd price from a market's outcomePrices JSON */
  parseCrowdPrice(market: PolymarketMarket): number | null {
    if (!market.outcomePrices) return null;
    try {
      const prices = JSON.parse(market.outcomePrices) as string[];
      if (prices.length >= 1) {
        const val = parseFloat(prices[0]);
        return isNaN(val) ? null : val;
      }
    } catch { /* malformed */ }
    return null;
  }
}
