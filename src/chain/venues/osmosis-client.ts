import type { Logger } from "../../logger.js";

export interface OsmosisVenueData {
  price_usd: number;
  volume_24h_usd: number;
  liquidity_usd: number;
  pool_id: string;
}

export class OsmosisClient {
  private lcdUrl: string;
  private logger: Logger;
  private cachedPoolId: string | null = null;

  constructor(lcdUrl: string, logger: Logger) {
    this.lcdUrl = lcdUrl.replace(/\/$/, "");
    this.logger = logger;
  }

  async discoverREGENPool(): Promise<string | null> {
    // Query /osmosis/gamm/v1beta1/pools with pagination, search for pool containing uregen IBC denom
    // The IBC denom for REGEN on Osmosis is ibc/... — search for base_denom=uregen in denom traces
    // Cache the pool ID
    try {
      // First try to find the IBC denom for uregen
      const traceRes = await this.fetchWithRetry(`${this.lcdUrl}/ibc/apps/transfer/v1/denom_traces?pagination.limit=200`);
      const traces = traceRes?.denom_traces || [];
      const regenTrace = traces.find((t: any) => t.base_denom === "uregen");

      if (!regenTrace) {
        this.logger.warn("Could not find REGEN IBC denom trace on Osmosis");
        return this.cachedPoolId;
      }

      // Now search pools for this denom
      const poolsRes = await this.fetchWithRetry(`${this.lcdUrl}/osmosis/gamm/v1beta1/pools?pagination.limit=100`);
      const pools = poolsRes?.pools || [];

      for (const pool of pools) {
        const assets = pool.pool_assets || pool.poolAssets || [];
        for (const asset of assets) {
          const denom = asset?.token?.denom || "";
          if (denom.includes("uregen") || (regenTrace && denom.includes(regenTrace.path?.split("/").pop()))) {
            this.cachedPoolId = pool.id || pool["@type"]?.split("/").pop();
            this.logger.info({ pool_id: this.cachedPoolId }, "Discovered REGEN pool on Osmosis");
            return this.cachedPoolId;
          }
        }
      }

      this.logger.warn("REGEN pool not found in Osmosis GAMM pools");
      return this.cachedPoolId;
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Osmosis pool discovery failed");
      return this.cachedPoolId;
    }
  }

  async getVenueData(): Promise<OsmosisVenueData | null> {
    try {
      const poolId = this.cachedPoolId || await this.discoverREGENPool();
      if (!poolId) return null;

      const poolRes = await this.fetchWithRetry(`${this.lcdUrl}/osmosis/gamm/v1beta1/pools/${poolId}`);
      if (!poolRes?.pool) return null;

      const assets = poolRes.pool.pool_assets || poolRes.pool.poolAssets || [];
      // Estimate price from pool reserves
      let regenAmount = 0;
      let otherAmount = 0;
      for (const asset of assets) {
        const denom = asset?.token?.denom || "";
        const amount = parseFloat(asset?.token?.amount || "0");
        if (denom.includes("uregen") || denom.startsWith("ibc/")) {
          // Heuristic: the non-OSMO, non-USDC token is likely REGEN
          if (denom.includes("uregen")) {
            regenAmount = amount / 1e6;
          } else {
            regenAmount = amount / 1e6; // assume 6 decimals
          }
        } else {
          otherAmount = amount / 1e6;
        }
      }

      // Rough price estimate if we have both sides
      const price = regenAmount > 0 && otherAmount > 0 ? otherAmount / regenAmount : 0;

      return {
        price_usd: price,
        volume_24h_usd: 0, // Osmosis LCD doesn't directly expose 24h volume
        liquidity_usd: (regenAmount + otherAmount) * (price || 0.04),
        pool_id: poolId,
      };
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Osmosis venue data fetch failed");
      return null;
    }
  }

  setCachedPoolId(id: string): void { this.cachedPoolId = id; }

  private async fetchWithRetry(url: string, retries = 2): Promise<any> {
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        if (i === retries) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
}
