import type { Logger } from "../../logger.js";

export interface CoinGeckoMarketData {
  price_usd: number;
  volume_24h_usd: number;
  market_cap_usd: number;
  price_change_24h_pct: number;
  platforms: Record<string, string>; // chain_name → contract_address
}

export interface CoinGeckoTicker {
  exchange: string;
  pair: string;
  price_usd: number;
  volume_24h_usd: number;
  trust_score: string;
  last_traded: string;
}

export class CoinGeckoClient {
  private baseUrl: string;
  private apiKey?: string;
  private cacheTtlMs: number;
  private logger: Logger;
  private cache: { data: any; timestamp: number } | null = null;

  constructor(logger: Logger) {
    this.apiKey = process.env.COINGECKO_API_KEY || undefined;
    this.baseUrl = this.apiKey
      ? "https://pro-api.coingecko.com/api/v3"
      : "https://api.coingecko.com/api/v3";
    this.cacheTtlMs = parseInt(process.env.COINGECKO_CACHE_TTL_MS || "300000", 10);
    this.logger = logger;
  }

  async getMarketData(): Promise<CoinGeckoMarketData | null> {
    try {
      const data = await this.fetchCached("/coins/regen?localization=false&tickers=false&community_data=false&developer_data=false");
      if (!data) return null;

      return {
        price_usd: data.market_data?.current_price?.usd ?? 0,
        volume_24h_usd: data.market_data?.total_volume?.usd ?? 0,
        market_cap_usd: data.market_data?.market_cap?.usd ?? 0,
        price_change_24h_pct: data.market_data?.price_change_percentage_24h ?? 0,
        platforms: data.platforms || {},
      };
    } catch (err) {
      this.logger.warn({ err: String(err) }, "CoinGecko market data fetch failed");
      return null;
    }
  }

  async getTickers(): Promise<CoinGeckoTicker[]> {
    try {
      const data = await this.fetchCached("/coins/regen/tickers");
      if (!data?.tickers) return [];

      return data.tickers.map((t: any) => ({
        exchange: t.market?.name || t.market?.identifier || "unknown",
        pair: t.target || "USD",
        price_usd: t.converted_last?.usd ?? 0,
        volume_24h_usd: t.converted_volume?.usd ?? 0,
        trust_score: t.trust_score || "unknown",
        last_traded: t.last_traded_at || "",
      }));
    } catch (err) {
      this.logger.warn({ err: String(err) }, "CoinGecko tickers fetch failed");
      return [];
    }
  }

  private async fetchCached(path: string): Promise<any> {
    const now = Date.now();
    if (this.cache && now - this.cache.timestamp < this.cacheTtlMs) {
      return this.cache.data;
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["x-cg-pro-api-key"] = this.apiKey;

    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          headers,
          signal: AbortSignal.timeout(12000),
        });
        if (res.status === 429) {
          this.logger.warn("CoinGecko rate limited, backing off 60s");
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this.cache = { data, timestamp: now };
        return data;
      } catch (err) {
        if (i === 1) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    return null;
  }
}
