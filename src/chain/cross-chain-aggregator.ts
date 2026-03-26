import fs from "node:fs";
import path from "node:path";
import { OsmosisClient } from "./venues/osmosis-client.js";
import { HydrexClient } from "./venues/hydrex-client.js";
import type { HydrexVenueData } from "./venues/hydrex-client.js";
import { AerodromeClient } from "./venues/aerodrome-client.js";
import { CoinGeckoClient } from "./venues/coingecko-client.js";
import { AxelarClient } from "./venues/axelar-client.js";
import type { BridgeFlowSnapshot } from "./venues/axelar-client.js";
import { VenueDiscovery } from "./venue-discovery.js";
import type { Logger } from "../logger.js";

export type VenueId = "regen_native" | "osmosis" | "hydrex_base" | "aerodrome_base" | "uniswap_celo" | "coingecko";

export interface VenuePrice {
  venue: VenueId;
  price_usd: number;
  volume_24h_usd: number;
  liquidity_usd: number;
  bid_ask_spread_pct?: number;
  last_updated: string;
  source_url: string;
  confidence: "high" | "medium" | "low";
}

export interface ArbitrageSignal {
  buy_venue: string;
  sell_venue: string;
  buy_price_usd: number;
  sell_price_usd: number;
  gross_spread_pct: number;
  estimated_bridge_cost_usd: number;
  estimated_gas_cost_usd: number;
  net_spread_pct: number;
  profitable: boolean;
  confidence: "high" | "medium" | "low";
  recommended_size_usd: number;
  expiry_estimate_minutes: number;
  notes: string;
}

export interface CrossChainSnapshot {
  timestamp: string;
  venues: VenuePrice[];
  best_bid_venue: string;
  best_ask_venue: string;
  spread_pct: number;
  weighted_price_usd: number;
  total_liquidity_usd: number;
  arbitrage_opportunity: ArbitrageSignal | null;
  bridge_flow: BridgeFlowSnapshot;
}

const MAX_HISTORY = 168; // 7 days hourly

/**
 * Cross-chain price aggregator — queries all REGEN trading venues
 * and produces a unified snapshot with arbitrage detection.
 */
export class CrossChainAggregator {
  private osmosis: OsmosisClient;
  private hydrex: HydrexClient;
  private aerodrome: AerodromeClient;
  private coingecko: CoinGeckoClient;
  private axelar: AxelarClient;
  private discovery: VenueDiscovery;
  private logger: Logger;
  private dataDir: string;
  private snapshotPath: string;
  private historyPath: string;
  private lastSnapshot: CrossChainSnapshot | null = null;
  /** Last Hydrex data — exposed for epoch/emission signal checks */
  public lastHydrexData: HydrexVenueData | null = null;

  constructor(dataDir: string, logger: Logger) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.snapshotPath = path.join(dataDir, "cross-chain-snapshot.json");
    this.historyPath = path.join(dataDir, "cross-chain-history.jsonl");

    const osmosisLcd = process.env.OSMOSIS_LCD_URL || "https://lcd.osmosis.zone";
    this.osmosis = new OsmosisClient(osmosisLcd, logger);
    this.hydrex = new HydrexClient(logger);
    this.aerodrome = new AerodromeClient(logger);
    this.coingecko = new CoinGeckoClient(logger);
    this.axelar = new AxelarClient(logger);
    this.discovery = new VenueDiscovery(dataDir, logger);
  }

  async init(): Promise<void> {
    const contracts = await this.discovery.refreshIfStale();
    if (contracts.osmosis_pool_id) this.osmosis.setCachedPoolId(contracts.osmosis_pool_id);
    if (contracts.regen_contract_base) this.aerodrome.setCachedContract(contracts.regen_contract_base);
    // Hydrex discovers its own pool dynamically
    await this.hydrex.discoverREGENPool();
    this.logger.info("CrossChainAggregator initialized (with Hydrex primary)");
  }

  async fetchAll(): Promise<CrossChainSnapshot> {
    const start = Date.now();
    this.logger.info("Fetching cross-chain prices from all venues...");

    // Fire all venue queries with Promise.allSettled
    const [osmosisResult, hydrexResult, aerodromeResult, coingeckoResult, bridgeResult] = await Promise.allSettled([
      this.fetchOsmosis(),
      this.fetchHydrex(),
      this.fetchAerodrome(),
      this.fetchCoinGecko(),
      this.axelar.getFlowSnapshot(24),
    ]);

    const venues: VenuePrice[] = [];

    if (osmosisResult.status === "fulfilled" && osmosisResult.value) {
      venues.push(osmosisResult.value);
    } else {
      this.logger.warn({ venue: "osmosis" }, "Osmosis fetch failed");
    }

    if (hydrexResult.status === "fulfilled" && hydrexResult.value) {
      venues.push(hydrexResult.value);
    } else {
      this.logger.warn({ venue: "hydrex_base" }, "Hydrex fetch failed");
    }

    if (aerodromeResult.status === "fulfilled" && aerodromeResult.value) {
      venues.push(aerodromeResult.value);
    } else {
      this.logger.warn({ venue: "aerodrome_base" }, "Aerodrome fetch failed");
    }

    if (coingeckoResult.status === "fulfilled" && coingeckoResult.value) {
      venues.push(coingeckoResult.value);
    } else {
      this.logger.warn({ venue: "coingecko" }, "CoinGecko fetch failed");
    }

    // Add regen_native from existing MCP data if available
    // (this is supplemented by the existing price monitoring in the scheduler)

    const bridgeFlow: BridgeFlowSnapshot = bridgeResult.status === "fulfilled"
      ? bridgeResult.value
      : { signal: "neutral", net_regen_24h: 0, net_usd_24h: 0, largest_tx: null, tx_count_24h: 0 };

    // Compute aggregated metrics
    const validVenues = venues.filter((v) => v.price_usd > 0);
    const totalVolume = validVenues.reduce((s, v) => s + v.volume_24h_usd, 0);
    const weightedPrice = totalVolume > 0
      ? validVenues.reduce((s, v) => s + v.price_usd * v.volume_24h_usd, 0) / totalVolume
      : validVenues.length > 0 ? validVenues[0].price_usd : 0;

    const sortedByPrice = [...validVenues].sort((a, b) => a.price_usd - b.price_usd);
    const bestAsk = sortedByPrice[0];
    const bestBid = sortedByPrice[sortedByPrice.length - 1];
    const spreadPct = bestAsk && bestBid && bestAsk.price_usd > 0
      ? ((bestBid.price_usd - bestAsk.price_usd) / bestAsk.price_usd) * 100
      : 0;

    const snapshot: CrossChainSnapshot = {
      timestamp: new Date().toISOString(),
      venues,
      best_bid_venue: bestBid?.venue || "none",
      best_ask_venue: bestAsk?.venue || "none",
      spread_pct: Math.round(spreadPct * 100) / 100,
      weighted_price_usd: Math.round(weightedPrice * 10000) / 10000,
      total_liquidity_usd: validVenues.reduce((s, v) => s + v.liquidity_usd, 0),
      arbitrage_opportunity: null, // filled by ArbitrageDetector
      bridge_flow: bridgeFlow,
    };

    this.lastSnapshot = snapshot;
    this.persist(snapshot);

    this.logger.info(
      { venues_found: venues.length, weighted_price: snapshot.weighted_price_usd, spread_pct: snapshot.spread_pct, duration_ms: Date.now() - start },
      "Cross-chain fetch complete"
    );

    return snapshot;
  }

  getLastSnapshot(): CrossChainSnapshot | null {
    return this.lastSnapshot;
  }

  // ─── Venue Fetchers ───────────────────────────────────────────────

  private async fetchOsmosis(): Promise<VenuePrice | null> {
    const data = await this.osmosis.getVenueData();
    if (!data || data.price_usd <= 0) return null;
    return {
      venue: "osmosis",
      price_usd: data.price_usd,
      volume_24h_usd: data.volume_24h_usd,
      liquidity_usd: data.liquidity_usd,
      last_updated: new Date().toISOString(),
      source_url: `https://lcd.osmosis.zone/osmosis/gamm/v1beta1/pools/${data.pool_id}`,
      confidence: "high",
    };
  }

  private async fetchHydrex(): Promise<VenuePrice | null> {
    const data = await this.hydrex.getVenueData();
    if (!data || data.price_usd <= 0) return null;
    this.lastHydrexData = data;
    return {
      venue: "hydrex_base",
      price_usd: data.price_usd,
      volume_24h_usd: data.volume_24h_usd,
      liquidity_usd: data.tvl_usd,
      last_updated: new Date().toISOString(),
      source_url: "https://hydrex.fi",
      confidence: "high", // direct on-chain pool query
    };
  }

  private async fetchAerodrome(): Promise<VenuePrice | null> {
    const data = await this.aerodrome.getVenueData();
    if (!data || data.price_usd <= 0) return null;
    return {
      venue: "aerodrome_base",
      price_usd: data.price_usd,
      volume_24h_usd: data.volume_24h_usd,
      liquidity_usd: data.liquidity_usd,
      last_updated: new Date().toISOString(),
      source_url: "https://aerodrome.finance",
      confidence: "medium", // secondary — via CoinGecko tickers
    };
  }

  private async fetchCoinGecko(): Promise<VenuePrice | null> {
    const data = await this.coingecko.getMarketData();
    if (!data || data.price_usd <= 0) return null;
    return {
      venue: "coingecko",
      price_usd: data.price_usd,
      volume_24h_usd: data.volume_24h_usd,
      liquidity_usd: data.market_cap_usd,
      last_updated: new Date().toISOString(),
      source_url: "https://api.coingecko.com/api/v3/coins/regen",
      confidence: "low", // aggregator, not direct on-chain
    };
  }

  // ─── Persistence ──────────────────────────────────────────────────

  private persist(snapshot: CrossChainSnapshot): void {
    try {
      const dir = path.dirname(this.snapshotPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Save latest snapshot
      fs.writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");

      // Append to history (trim to MAX_HISTORY)
      fs.appendFileSync(this.historyPath, JSON.stringify(snapshot) + "\n", "utf-8");
      this.trimHistory();
    } catch (err) {
      this.logger.error({ err }, "Failed to persist cross-chain snapshot");
    }
  }

  private trimHistory(): void {
    try {
      if (!fs.existsSync(this.historyPath)) return;
      const lines = fs.readFileSync(this.historyPath, "utf-8").split("\n").filter(Boolean);
      if (lines.length > MAX_HISTORY) {
        fs.writeFileSync(this.historyPath, lines.slice(-MAX_HISTORY).join("\n") + "\n", "utf-8");
      }
    } catch {}
  }

  loadHistory(): CrossChainSnapshot[] {
    try {
      if (!fs.existsSync(this.historyPath)) return [];
      return fs.readFileSync(this.historyPath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  }
}
