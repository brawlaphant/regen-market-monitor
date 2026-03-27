import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface PricePoint {
  timestamp: string;
  price_usd: number;
  volume_24h: number;
  source: "coingecko" | "live";
}

export interface PriceDataset {
  points: PricePoint[];
  venue: string;
  from: string;
  to: string;
  count: number;
}

const CACHE_HOURS = 24;

export class HistoryCollector {
  private dataDir: string;
  private logger: Logger;
  private cachePath: string;

  constructor(dataDir: string, logger: Logger) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.cachePath = path.join(dataDir, "backtest-price-history.json");
  }

  async collectPriceHistory(days = 90): Promise<PriceDataset> {
    // Check cache
    const cached = this.loadCache();
    if (cached && Date.now() - new Date(cached.to).getTime() < CACHE_HOURS * 3600000) {
      this.logger.info({ points: cached.count }, "Using cached price history");
      return cached;
    }

    const points: PricePoint[] = [];

    // CoinGecko historical data
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/regen/market_chart?vs_currency=usd&days=${days}&interval=hourly`,
        { signal: AbortSignal.timeout(30000) }
      );
      if (res.ok) {
        const data = (await res.json()) as any;
        const prices = data?.prices || [];
        const volumes = data?.total_volumes || [];
        for (let i = 0; i < prices.length; i++) {
          points.push({
            timestamp: new Date(prices[i][0]).toISOString(),
            price_usd: prices[i][1],
            volume_24h: volumes[i]?.[1] || 0,
            source: "coingecko",
          });
        }
        this.logger.info({ coingecko_points: prices.length }, "CoinGecko history collected");
      }
    } catch (err) {
      this.logger.warn({ err: String(err) }, "CoinGecko history fetch failed");
    }

    // Live data from cross-chain-history.jsonl
    try {
      const histPath = path.join(this.dataDir, "cross-chain-history.jsonl");
      if (fs.existsSync(histPath)) {
        const lines = fs.readFileSync(histPath, "utf-8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const snap = JSON.parse(line);
            if (snap.weighted_price_usd > 0) {
              points.push({
                timestamp: snap.timestamp,
                price_usd: snap.weighted_price_usd,
                volume_24h: snap.venues?.reduce((s: number, v: any) => s + (v.volume_24h_usd || 0), 0) || 0,
                source: "live",
              });
            }
          } catch {}
        }
      }
    } catch {}

    // Deduplicate by timestamp (nearest hour), sort chronologically
    const deduped = this.deduplicate(points);
    deduped.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (deduped.length < 720) { // 30 days
      this.logger.warn({ points: deduped.length }, "Less than 30 days of data available");
    }

    const dataset: PriceDataset = {
      points: deduped,
      venue: "aggregated",
      from: deduped[0]?.timestamp || new Date().toISOString(),
      to: deduped[deduped.length - 1]?.timestamp || new Date().toISOString(),
      count: deduped.length,
    };

    this.saveCache(dataset);
    return dataset;
  }

  private deduplicate(points: PricePoint[]): PricePoint[] {
    const seen = new Map<string, PricePoint>();
    for (const p of points) {
      const hourKey = p.timestamp.slice(0, 13); // YYYY-MM-DDTHH
      if (!seen.has(hourKey) || p.source === "live") {
        seen.set(hourKey, p);
      }
    }
    return Array.from(seen.values());
  }

  private loadCache(): PriceDataset | null {
    try {
      if (!fs.existsSync(this.cachePath)) return null;
      return JSON.parse(fs.readFileSync(this.cachePath, "utf-8"));
    } catch { return null; }
  }

  private saveCache(dataset: PriceDataset): void {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(dataset), "utf-8");
    } catch {}
  }
}
