import type { CrossChainSnapshot, ArbitrageSignal, VenuePrice } from "./cross-chain-aggregator.js";
import type { Logger } from "../logger.js";

const DEFAULT_DETECTION_THRESHOLD = 2.0; // min gross spread %
const DEFAULT_MIN_PROFIT_PCT = 1.0;      // min net spread %

interface BridgeCost {
  cost_usd: number;
  gas_usd: number;
  swap_fee_pct: number;
  latency_minutes: number;
  description: string;
}

/** Estimated costs for bridging between venue pairs */
const BRIDGE_COSTS: Record<string, BridgeCost> = {
  "regen_native→osmosis": { cost_usd: 0.01, gas_usd: 0.01, swap_fee_pct: 0.2, latency_minutes: 15, description: "IBC transfer ~15min + 0.2% Osmosis swap fee" },
  "osmosis→regen_native": { cost_usd: 0.01, gas_usd: 0.01, swap_fee_pct: 0.2, latency_minutes: 15, description: "IBC transfer ~15min + 0.2% Osmosis swap fee" },
  "regen_native→aerodrome_base": { cost_usd: 3.0, gas_usd: 0.01, swap_fee_pct: 0.3, latency_minutes: 5, description: "Axelar bridge ~$3 + ~5min + 0.3% Aerodrome fee" },
  "aerodrome_base→regen_native": { cost_usd: 3.0, gas_usd: 0.01, swap_fee_pct: 0.3, latency_minutes: 5, description: "Axelar bridge ~$3 + ~5min + 0.3% Aerodrome fee" },
  "osmosis→aerodrome_base": { cost_usd: 3.5, gas_usd: 0.02, swap_fee_pct: 0.5, latency_minutes: 20, description: "IBC→Regen→Axelar→Base ~20min + ~$3.50 + 0.5% total fees" },
  "aerodrome_base→osmosis": { cost_usd: 3.5, gas_usd: 0.02, swap_fee_pct: 0.5, latency_minutes: 20, description: "Axelar→Regen→IBC→Osmosis ~20min + ~$3.50 + 0.5% total fees" },
};
const DEFAULT_BRIDGE_COST: BridgeCost = { cost_usd: 5.0, gas_usd: 0.05, swap_fee_pct: 0.5, latency_minutes: 30, description: "Estimated multi-hop bridge + swap fees" };
const SLIPPAGE_PER_1000_USD = 0.005; // 0.5% per $1000

/**
 * Arbitrage detector — compares all venue pairs and identifies profitable spreads.
 * Never recommends trades — produces intelligence only.
 */
export class ArbitrageDetector {
  private detectionThreshold: number;
  private minProfitPct: number;
  private logger: Logger;
  private recentDetections: ArbitrageSignal[] = [];

  constructor(logger: Logger) {
    this.detectionThreshold = parseFloat(process.env.ARBIT_DETECTION_THRESHOLD || String(DEFAULT_DETECTION_THRESHOLD));
    this.minProfitPct = parseFloat(process.env.ARBIT_MIN_PROFIT_PCT || String(DEFAULT_MIN_PROFIT_PCT));
    this.logger = logger;
  }

  detectArbitrage(snapshot: CrossChainSnapshot): ArbitrageSignal | null {
    const venues = snapshot.venues.filter((v) => v.price_usd > 0);
    if (venues.length < 2) return null;

    let bestSignal: ArbitrageSignal | null = null;

    for (let i = 0; i < venues.length; i++) {
      for (let j = i + 1; j < venues.length; j++) {
        const [low, high] = venues[i].price_usd < venues[j].price_usd
          ? [venues[i], venues[j]]
          : [venues[j], venues[i]];

        const grossSpread = ((high.price_usd - low.price_usd) / low.price_usd) * 100;
        if (grossSpread < this.detectionThreshold) continue;

        const signal = this.buildSignal(low, high, grossSpread);
        if (!bestSignal || signal.net_spread_pct > bestSignal.net_spread_pct) {
          bestSignal = signal;
        }
      }
    }

    if (bestSignal) {
      this.recentDetections.push(bestSignal);
      if (this.recentDetections.length > 50) this.recentDetections.shift();

      this.logger.info(
        {
          buy: bestSignal.buy_venue,
          sell: bestSignal.sell_venue,
          gross_pct: bestSignal.gross_spread_pct,
          net_pct: bestSignal.net_spread_pct,
          profitable: bestSignal.profitable,
          confidence: bestSignal.confidence,
        },
        "Arbitrage opportunity detected"
      );
    }

    return bestSignal;
  }

  getRecentDetections(limit = 10): ArbitrageSignal[] {
    return [...this.recentDetections].reverse().slice(0, limit);
  }

  private buildSignal(buyVenue: VenuePrice, sellVenue: VenuePrice, grossSpread: number): ArbitrageSignal {
    const routeKey = `${buyVenue.venue}→${sellVenue.venue}`;
    const bridge = BRIDGE_COSTS[routeKey] || DEFAULT_BRIDGE_COST;

    // Estimate trade size capped at liquidity/10
    const maxSize = Math.min(buyVenue.liquidity_usd, sellVenue.liquidity_usd) / 10;
    const tradeSize = Math.min(maxSize, 5000); // practical cap

    const slippage = (tradeSize / 1000) * SLIPPAGE_PER_1000_USD * 100;
    const totalFeePct = bridge.swap_fee_pct + slippage;
    const fixedCosts = bridge.cost_usd + bridge.gas_usd;
    const fixedCostPct = tradeSize > 0 ? (fixedCosts / tradeSize) * 100 : 100;
    const netSpread = grossSpread - totalFeePct - fixedCostPct;

    // Confidence based on venue data freshness
    const now = Date.now();
    const buyAge = now - new Date(buyVenue.last_updated).getTime();
    const sellAge = now - new Date(sellVenue.last_updated).getTime();
    const staleThreshold = 10 * 60 * 1000; // 10 min

    let confidence: "high" | "medium" | "low";
    if (buyAge > staleThreshold || sellAge > staleThreshold) {
      confidence = "low";
    } else if (buyVenue.confidence === "low" || sellVenue.confidence === "low") {
      confidence = "medium";
    } else if (buyVenue.confidence === "high" && sellVenue.confidence === "high") {
      confidence = "high";
    } else {
      confidence = "medium";
    }

    return {
      buy_venue: buyVenue.venue,
      sell_venue: sellVenue.venue,
      buy_price_usd: buyVenue.price_usd,
      sell_price_usd: sellVenue.price_usd,
      gross_spread_pct: Math.round(grossSpread * 100) / 100,
      estimated_bridge_cost_usd: fixedCosts,
      estimated_gas_cost_usd: bridge.gas_usd,
      net_spread_pct: Math.round(netSpread * 100) / 100,
      profitable: netSpread > this.minProfitPct,
      confidence,
      recommended_size_usd: Math.round(tradeSize),
      expiry_estimate_minutes: bridge.latency_minutes,
      notes: bridge.description,
    };
  }
}
