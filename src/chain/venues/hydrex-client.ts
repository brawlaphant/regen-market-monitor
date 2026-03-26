import type { Logger } from "../../logger.js";

export interface HydrexPoolData {
  pool_id: string;
  price_usd: number;
  tvl_usd: number;
  volume_24h_usd: number;
  fee_apr_pct: number;
  regen_reserves: number;
  weth_reserves: number;
}

export interface HydrexEmissionData {
  votes_toward_regen: number;
  total_epoch_votes: number;
  vote_share_pct: number;
  emission_rate_hydx_per_epoch: number;
  incentive_apr_pct: number;
  combined_apr_pct: number;
  vote_trend: "increasing" | "decreasing" | "stable";
  vote_change_pct: number;
}

export interface HydrexEpochInfo {
  current_epoch: number;
  snapshot_at: string;
  hours_until_flip: number;
}

export type EmissionSignal = "accumulating_incentives" | "losing_incentives" | "epoch_transition";

export interface HydrexVenueData {
  price_usd: number;
  tvl_usd: number;
  volume_24h_usd: number;
  fee_apr_pct: number;
  incentive_apr_pct: number;
  combined_apr_pct: number;
  pool_id: string;
  epoch_info: HydrexEpochInfo;
  emission_signal: EmissionSignal | null;
  vote_trend: string;
  vote_change_pct: number;
}

/**
 * Hydrex MetaDEX client — primary REGEN venue on Base.
 * WETH/REGEN full-range LP with HYDX ve-model epoch emissions.
 * Discovers pool dynamically via Hydrex API.
 */
export class HydrexClient {
  private apiUrl: string;
  private logger: Logger;
  private cachedPoolId: string | null = null;
  private previousVotes: number | null = null;

  constructor(logger: Logger) {
    this.apiUrl = (process.env.HYDREX_API_URL || "https://api.hydrex.fi").replace(/\/$/, "");
    this.logger = logger;
  }

  setCachedPoolId(id: string): void {
    this.cachedPoolId = id;
  }

  async discoverREGENPool(): Promise<string | null> {
    try {
      const res = await fetch(`${this.apiUrl}/pools`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "Hydrex pools endpoint returned non-OK");
        return this.cachedPoolId;
      }

      const data = (await res.json()) as any;
      const pools = Array.isArray(data) ? data : data?.pools || data?.data || [];

      for (const pool of pools) {
        const tokens = [
          pool.token0?.symbol?.toUpperCase(),
          pool.token1?.symbol?.toUpperCase(),
          pool.tokenA?.symbol?.toUpperCase(),
          pool.tokenB?.symbol?.toUpperCase(),
        ].filter(Boolean);

        if (tokens.includes("REGEN")) {
          this.cachedPoolId = pool.id || pool.address || pool.pool_id || null;
          this.logger.info({ pool_id: this.cachedPoolId }, "Discovered REGEN pool on Hydrex");
          return this.cachedPoolId;
        }
      }

      this.logger.warn("REGEN pool not found in Hydrex pools listing");
      return this.cachedPoolId;
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Hydrex pool discovery failed");
      return this.cachedPoolId;
    }
  }

  async getPoolData(): Promise<HydrexPoolData | null> {
    try {
      const poolId = this.cachedPoolId || (await this.discoverREGENPool());
      if (!poolId) return null;

      const res = await fetch(`${this.apiUrl}/pools/${poolId}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as any;
      const pool = data?.pool || data;

      const tvl = parseFloat(pool.tvl || pool.tvlUSD || pool.liquidity || "0");
      const vol = parseFloat(pool.volume24h || pool.volumeUSD || "0");
      const feeApr = parseFloat(pool.feeAPR || pool.fee_apr || pool.apr?.fee || "0");

      // Compute price from reserves if available
      const regen = parseFloat(pool.reserve0 || pool.token0Amount || "0");
      const weth = parseFloat(pool.reserve1 || pool.token1Amount || "0");
      const wethPriceUsd = 3500; // approximate; could be fetched dynamically
      const price = regen > 0 && weth > 0 ? (weth * wethPriceUsd) / regen : 0;

      return {
        pool_id: poolId,
        price_usd: price,
        tvl_usd: tvl,
        volume_24h_usd: vol,
        fee_apr_pct: feeApr,
        regen_reserves: regen,
        weth_reserves: weth,
      };
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Hydrex pool data fetch failed");
      return null;
    }
  }

  async getEmissions(): Promise<HydrexEmissionData | null> {
    try {
      const poolId = this.cachedPoolId;
      if (!poolId) return null;

      const res = await fetch(`${this.apiUrl}/emissions/${poolId}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        // Fallback: try general emissions endpoint
        const fallback = await fetch(`${this.apiUrl}/emissions`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(12000),
        });
        if (!fallback.ok) return null;
        const allData = (await fallback.json()) as any;
        const pools = Array.isArray(allData) ? allData : allData?.pools || [];
        const match = pools.find((p: any) => p.pool_id === poolId || p.address === poolId);
        if (!match) return null;
        return this.parseEmissions(match);
      }

      const data = (await res.json()) as any;
      return this.parseEmissions(data);
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Hydrex emissions fetch failed");
      return null;
    }
  }

  async getEpochInfo(): Promise<HydrexEpochInfo> {
    try {
      const res = await fetch(`${this.apiUrl}/epoch`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return this.defaultEpochInfo();

      const data = (await res.json()) as any;
      const snapshotAt = data.snapshot_at || data.flipAt || data.next_epoch_at || "";
      const hoursUntil = snapshotAt
        ? Math.max(0, (new Date(snapshotAt).getTime() - Date.now()) / 3600000)
        : 168; // default 7 days

      return {
        current_epoch: data.current_epoch || data.epoch || 0,
        snapshot_at: snapshotAt || new Date(Date.now() + 168 * 3600000).toISOString(),
        hours_until_flip: Math.round(hoursUntil * 10) / 10,
      };
    } catch {
      return this.defaultEpochInfo();
    }
  }

  computeEmissionSignal(emissions: HydrexEmissionData | null, epochInfo: HydrexEpochInfo): EmissionSignal | null {
    if (epochInfo.hours_until_flip < 6) return "epoch_transition";
    if (!emissions) return null;
    if (emissions.vote_trend === "increasing") return "accumulating_incentives";
    if (emissions.vote_trend === "decreasing") return "losing_incentives";
    return null;
  }

  async getVenueData(): Promise<HydrexVenueData | null> {
    try {
      const [poolData, emissions, epochInfo] = await Promise.all([
        this.getPoolData(),
        this.getEmissions(),
        this.getEpochInfo(),
      ]);

      if (!poolData) return null;

      const signal = this.computeEmissionSignal(emissions, epochInfo);

      return {
        price_usd: poolData.price_usd,
        tvl_usd: poolData.tvl_usd,
        volume_24h_usd: poolData.volume_24h_usd,
        fee_apr_pct: poolData.fee_apr_pct,
        incentive_apr_pct: emissions?.incentive_apr_pct ?? 0,
        combined_apr_pct: emissions?.combined_apr_pct ?? poolData.fee_apr_pct,
        pool_id: poolData.pool_id,
        epoch_info: epochInfo,
        emission_signal: signal,
        vote_trend: emissions?.vote_trend ?? "stable",
        vote_change_pct: emissions?.vote_change_pct ?? 0,
      };
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Hydrex venue data fetch failed");
      return null;
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private parseEmissions(data: any): HydrexEmissionData {
    const votes = parseFloat(data.votes || data.votes_toward_pool || "0");
    const totalVotes = parseFloat(data.total_votes || data.total_epoch_votes || "1");
    const emissionRate = parseFloat(data.emission_rate || data.emissions_per_epoch || "0");
    const incentiveApr = parseFloat(data.incentive_apr || data.rewardAPR || "0");
    const feeApr = parseFloat(data.fee_apr || "0");

    // Compute trend vs previous poll
    let trend: "increasing" | "decreasing" | "stable" = "stable";
    let changePct = 0;
    if (this.previousVotes !== null && this.previousVotes > 0) {
      changePct = ((votes - this.previousVotes) / this.previousVotes) * 100;
      if (changePct > 5) trend = "increasing";
      else if (changePct < -5) trend = "decreasing";
    }
    this.previousVotes = votes;

    return {
      votes_toward_regen: votes,
      total_epoch_votes: totalVotes,
      vote_share_pct: totalVotes > 0 ? (votes / totalVotes) * 100 : 0,
      emission_rate_hydx_per_epoch: emissionRate,
      incentive_apr_pct: incentiveApr,
      combined_apr_pct: feeApr + incentiveApr,
      vote_trend: trend,
      vote_change_pct: Math.round(changePct * 10) / 10,
    };
  }

  private defaultEpochInfo(): HydrexEpochInfo {
    return {
      current_epoch: 0,
      snapshot_at: new Date(Date.now() + 168 * 3600000).toISOString(),
      hours_until_flip: 168,
    };
  }
}
