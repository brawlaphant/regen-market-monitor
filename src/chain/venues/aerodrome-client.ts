import type { Logger } from "../../logger.js";

export interface AerodromeVenueData {
  price_usd: number;
  volume_24h_usd: number;
  liquidity_usd: number;
  contract_address: string;
}

/**
 * Aerodrome (Base chain) REGEN/USDC pair.
 * Uses CoinGecko tickers as primary data source since direct on-chain pool
 * queries require the specific pool contract address which varies.
 * Falls back to DeFiLlama for price verification.
 */
export class AerodromeClient {
  private baseRpcUrl: string;
  private logger: Logger;
  private cachedContract: string | null = null;

  constructor(logger: Logger) {
    this.baseRpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
    this.logger = logger;
  }

  setCachedContract(address: string): void {
    this.cachedContract = address;
  }

  async getVenueData(): Promise<AerodromeVenueData | null> {
    try {
      // Try CoinGecko tickers for Aerodrome data
      const res = await fetch(
        "https://api.coingecko.com/api/v3/coins/regen/tickers",
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) }
      );
      if (!res.ok) return null;

      const data = await res.json() as any;
      const tickers = data?.tickers || [];

      // Find Aerodrome ticker
      const aeroTicker = tickers.find((t: any) =>
        (t.market?.identifier || "").toLowerCase().includes("aerodrome") ||
        (t.market?.name || "").toLowerCase().includes("aerodrome")
      );

      if (aeroTicker) {
        return {
          price_usd: aeroTicker.converted_last?.usd ?? 0,
          volume_24h_usd: aeroTicker.converted_volume?.usd ?? 0,
          liquidity_usd: (aeroTicker.converted_volume?.usd ?? 0) * 2, // rough TVL estimate
          contract_address: this.cachedContract || "discovered",
        };
      }

      // Fallback: try DeFiLlama if we have a contract address
      if (this.cachedContract) {
        return await this.fetchFromLlama();
      }

      return null;
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Aerodrome venue data fetch failed");
      return null;
    }
  }

  private async fetchFromLlama(): Promise<AerodromeVenueData | null> {
    try {
      const res = await fetch(
        `https://coins.llama.fi/prices/current/base:${this.cachedContract}`,
        { signal: AbortSignal.timeout(12000) }
      );
      if (!res.ok) return null;

      const data = await res.json() as any;
      const key = Object.keys(data?.coins || {})[0];
      const coin = data?.coins?.[key];
      if (!coin) return null;

      return {
        price_usd: coin.price ?? 0,
        volume_24h_usd: 0,
        liquidity_usd: 0,
        contract_address: this.cachedContract!,
      };
    } catch {
      return null;
    }
  }
}
