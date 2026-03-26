import type { Logger } from "../../logger.js";

export interface BridgeFlow {
  tx_hash: string;
  source_chain: string;
  dest_chain: string;
  amount_regen: number;
  amount_usd: number;
  timestamp: string;
  direction: "in" | "out"; // in = arriving on Regen, out = leaving
}

export interface NetFlowResult {
  net_regen: number;
  net_usd: number;
  inflows: number;
  outflows: number;
}

export interface BridgeFlowSnapshot {
  signal: "accumulation" | "distribution" | "neutral";
  net_regen_24h: number;
  net_usd_24h: number;
  largest_tx: BridgeFlow | null;
  tx_count_24h: number;
}

export class AxelarClient {
  private apiUrl: string;
  private logger: Logger;
  private accumulationThreshold: number;
  private distributionThreshold: number;

  constructor(logger: Logger) {
    this.apiUrl = (process.env.AXELAR_API_URL || "https://api.axelarscan.io").replace(/\/$/, "");
    this.logger = logger;
    this.accumulationThreshold = parseFloat(process.env.FLOW_ACCUMULATION_THRESHOLD || "10000");
    this.distributionThreshold = parseFloat(process.env.FLOW_DISTRIBUTION_THRESHOLD || "10000");
  }

  async getBridgeFlows(hours = 24): Promise<BridgeFlow[]> {
    try {
      const res = await fetch(
        `${this.apiUrl}/cross-chain/transfers?asset=regen&size=50`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) }
      );
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "Axelar bridge flows fetch failed");
        return [];
      }

      const data = await res.json() as any;
      const transfers = data?.data || data?.transfers || data || [];
      if (!Array.isArray(transfers)) return [];

      const cutoff = Date.now() - hours * 60 * 60 * 1000;

      return transfers
        .filter((t: any) => {
          const ts = t.created_at?.ms || t.timestamp || 0;
          return typeof ts === "number" ? ts > cutoff : new Date(ts).getTime() > cutoff;
        })
        .map((t: any) => {
          const sourceChain = t.send?.source_chain || t.source_chain || "";
          const destChain = t.send?.destination_chain || t.destination_chain || "";
          const amount = parseFloat(t.send?.amount || t.amount || "0") / 1e6;

          return {
            tx_hash: t.send?.txhash || t.tx_hash || "",
            source_chain: sourceChain,
            dest_chain: destChain,
            amount_regen: amount,
            amount_usd: amount * 0.04, // rough estimate
            timestamp: new Date(t.created_at?.ms || t.timestamp || Date.now()).toISOString(),
            direction: destChain.toLowerCase().includes("regen") ? "in" as const : "out" as const,
          };
        });
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Axelar bridge flows query failed");
      return [];
    }
  }

  async getNetFlow(hours = 24): Promise<NetFlowResult> {
    const flows = await this.getBridgeFlows(hours);
    let inflows = 0;
    let outflows = 0;

    for (const f of flows) {
      if (f.direction === "in") inflows += f.amount_regen;
      else outflows += f.amount_regen;
    }

    return {
      net_regen: inflows - outflows,
      net_usd: (inflows - outflows) * 0.04,
      inflows,
      outflows,
    };
  }

  computeFlowSignal(netFlow: NetFlowResult): "accumulation" | "distribution" | "neutral" {
    if (netFlow.net_regen > this.accumulationThreshold) return "accumulation";
    if (netFlow.net_regen < -this.distributionThreshold) return "distribution";
    return "neutral";
  }

  async getFlowSnapshot(hours = 24): Promise<BridgeFlowSnapshot> {
    const flows = await this.getBridgeFlows(hours);
    const netFlow = await this.getNetFlow(hours);
    const signal = this.computeFlowSignal(netFlow);
    const largest = flows.length > 0
      ? flows.reduce((max, f) => f.amount_regen > max.amount_regen ? f : max, flows[0])
      : null;

    return {
      signal,
      net_regen_24h: netFlow.net_regen,
      net_usd_24h: netFlow.net_usd,
      largest_tx: largest,
      tx_count_24h: flows.length,
    };
  }
}
