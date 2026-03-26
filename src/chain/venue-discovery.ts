import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface VenueContracts {
  osmosis_pool_id: string;
  regen_ibc_denom_osmosis: string;
  regen_contract_base: string;
  regen_contract_celo: string;
  last_discovered: string;
}

const DEFAULT_TTL_DAYS = 7;

/**
 * Discovers venue contracts/pool IDs dynamically — never hardcodes addresses.
 * Caches to data/venue-contracts.json with configurable TTL.
 */
export class VenueDiscovery {
  private dataDir: string;
  private logger: Logger;
  private cachePath: string;
  private ttlMs: number;
  private cached: VenueContracts | null = null;

  constructor(dataDir: string, logger: Logger) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.cachePath = path.join(dataDir, "venue-contracts.json");
    this.ttlMs = parseInt(process.env.VENUE_DISCOVERY_TTL_DAYS || String(DEFAULT_TTL_DAYS), 10) * 86400000;
    this.loadCache();
  }

  async refreshIfStale(): Promise<VenueContracts> {
    if (this.cached && !this.isStale()) {
      this.logger.info("Venue contracts cache is fresh");
      return this.cached;
    }

    this.logger.info("Discovering venue contracts...");
    const fresh = await this.discoverAll();
    this.saveCache(fresh);
    return fresh;
  }

  async discoverAll(): Promise<VenueContracts> {
    const current = this.cached || emptyContracts();

    // Discover Base and Celo contracts via CoinGecko platforms
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/coins/regen?localization=false&tickers=false&community_data=false&developer_data=false",
        { signal: AbortSignal.timeout(12000) }
      );
      if (res.ok) {
        const data = (await res.json()) as any;
        const platforms = data.platforms || {};
        if (platforms["base"]) current.regen_contract_base = platforms["base"];
        if (platforms["celo"]) current.regen_contract_celo = platforms["celo"];
        this.logger.info(
          { base: current.regen_contract_base || "not found", celo: current.regen_contract_celo || "not found" },
          "CoinGecko platform discovery complete"
        );
      }
    } catch (err) {
      this.logger.warn({ err: String(err) }, "CoinGecko platform discovery failed — using cached");
    }

    // Discover Osmosis pool via IBC denom trace
    try {
      const traceRes = await fetch(
        `${process.env.OSMOSIS_LCD_URL || "https://lcd.osmosis.zone"}/ibc/apps/transfer/v1/denom_traces?pagination.limit=500`,
        { signal: AbortSignal.timeout(12000) }
      );
      if (traceRes.ok) {
        const traceData = (await traceRes.json()) as any;
        const traces = traceData?.denom_traces || [];
        const regenTrace = traces.find((t: any) => t.base_denom === "uregen");
        if (regenTrace) {
          current.regen_ibc_denom_osmosis = `ibc/${regenTrace.path}`;
          this.logger.info({ denom: current.regen_ibc_denom_osmosis }, "Found REGEN IBC denom on Osmosis");
        }
      }
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Osmosis IBC denom discovery failed — using cached");
    }

    current.last_discovered = new Date().toISOString();
    return current;
  }

  getContracts(): VenueContracts {
    return this.cached || emptyContracts();
  }

  private isStale(): boolean {
    if (!this.cached?.last_discovered) return true;
    return Date.now() - new Date(this.cached.last_discovered).getTime() > this.ttlMs;
  }

  private loadCache(): void {
    try {
      if (!fs.existsSync(this.cachePath)) return;
      this.cached = JSON.parse(fs.readFileSync(this.cachePath, "utf-8"));
    } catch {
      this.logger.warn("Failed to load venue contracts cache");
    }
  }

  private saveCache(contracts: VenueContracts): void {
    this.cached = contracts;
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(contracts, null, 2), "utf-8");
    } catch (err) {
      this.logger.error({ err }, "Failed to save venue contracts cache");
    }
  }
}

function emptyContracts(): VenueContracts {
  return {
    osmosis_pool_id: "",
    regen_ibc_denom_osmosis: "",
    regen_contract_base: "",
    regen_contract_celo: "",
    last_discovered: "",
  };
}
