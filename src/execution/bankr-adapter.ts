import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface TradeOrder {
  id: string;
  signal_id: string;
  phase: "accumulation" | "listing_volume" | "market_making" | "exit";
  chain: "base" | "polygon" | "ethereum" | "solana" | "osmosis";
  action: "buy" | "sell";
  token_in: string;
  token_out: string;
  amount_usd: number;
  max_slippage_pct: number;
  venue: string;
  priority: "low" | "medium" | "high";
  requires_approval: boolean;
  status: "pending_approval" | "approved" | "executing" | "complete" | "failed" | "rejected";
  tx_hash?: string;
  executed_price_usd?: number;
  executed_amount_regen?: number;
  gas_cost_usd?: number;
  created_at: string;
  executed_at?: string;
}

export interface ExecutionResult {
  success: boolean;
  order: TradeOrder;
  error?: string;
}

export interface EstimateResult {
  expected_price: number;
  price_impact_pct: number;
  gas_estimate_usd: number;
  route: string;
}

interface DailyCap {
  date: string;
  buy_usd: number;
  sell_usd: number;
}

/**
 * Wraps the Bankr skill for structured trade execution.
 * Enforces daily caps, single-order limits, and approval gates.
 * EXECUTION_ENABLED must be explicitly true to execute any trade.
 */
export class BankrAdapter {
  private logger: Logger;
  private dataDir: string;
  private enabled: boolean;
  private dailyBuyCap: number;
  private dailySellCap: number;
  private singleOrderMax: number;
  private approvalThreshold: number;
  private maxPriceImpact: number;
  private capPath: string;
  private dailyCap: DailyCap;

  /** Approval callback — set from index.ts */
  public onApprovalRequired: ((order: TradeOrder) => Promise<void>) | null = null;

  constructor(dataDir: string, logger: Logger) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.enabled = process.env.EXECUTION_ENABLED === "true";
    this.dailyBuyCap = parseFloat(process.env.DAILY_BUY_CAP_USD || "100");
    this.dailySellCap = parseFloat(process.env.DAILY_SELL_CAP_USD || "50");
    this.singleOrderMax = parseFloat(process.env.SINGLE_ORDER_MAX_USD || "50");
    this.approvalThreshold = parseFloat(process.env.EXECUTION_THRESHOLD_USD || "20");
    this.maxPriceImpact = parseFloat(process.env.MAX_PRICE_IMPACT_PCT || "2.0");
    this.capPath = path.join(dataDir, "execution-daily-cap.json");
    this.dailyCap = this.loadDailyCap();

    if (!this.enabled) {
      this.logger.warn("EXECUTION_ENABLED=false — all trade execution disabled");
    }
  }

  async execute(order: TradeOrder): Promise<ExecutionResult> {
    if (!this.enabled) {
      return { success: false, order, error: "Execution disabled (EXECUTION_ENABLED=false)" };
    }

    // Enforce single order max
    if (order.amount_usd > this.singleOrderMax) {
      return { success: false, order, error: `Order $${order.amount_usd} exceeds SINGLE_ORDER_MAX_USD ($${this.singleOrderMax})` };
    }

    // Enforce daily caps
    this.refreshDailyCap();
    if (order.action === "buy" && this.dailyCap.buy_usd + order.amount_usd > this.dailyBuyCap) {
      return { success: false, order, error: `Daily buy cap exhausted ($${this.dailyCap.buy_usd}/$${this.dailyBuyCap})` };
    }
    if (order.action === "sell" && this.dailyCap.sell_usd + order.amount_usd > this.dailySellCap) {
      return { success: false, order, error: `Daily sell cap exhausted ($${this.dailyCap.sell_usd}/$${this.dailySellCap})` };
    }

    // Route to approval if above threshold
    if (order.requires_approval || order.amount_usd > this.approvalThreshold) {
      order.status = "pending_approval";
      order.requires_approval = true;
      if (this.onApprovalRequired) {
        await this.onApprovalRequired(order);
      }
      this.logger.info({ order_id: order.id, amount: order.amount_usd }, "Trade routed to approval gate");
      return { success: true, order };
    }

    return this.executeDirectly(order);
  }

  /** Execute after approval */
  async executeApproved(order: TradeOrder): Promise<ExecutionResult> {
    if (!this.enabled) {
      return { success: false, order, error: "Execution disabled" };
    }
    order.status = "approved";
    return this.executeDirectly(order);
  }

  async estimateOrder(order: TradeOrder): Promise<EstimateResult> {
    // Estimate without executing — uses venue price data
    return {
      expected_price: 0.04, // placeholder — would call Bankr quote API
      price_impact_pct: order.amount_usd > 500 ? 1.5 : 0.3,
      gas_estimate_usd: order.chain === "base" ? 0.01 : 0.05,
      route: `${order.token_in} → ${order.token_out} on ${order.venue}`,
    };
  }

  getDailyCapRemaining(): { buy_remaining: number; sell_remaining: number } {
    this.refreshDailyCap();
    return {
      buy_remaining: Math.max(0, this.dailyBuyCap - this.dailyCap.buy_usd),
      sell_remaining: Math.max(0, this.dailySellCap - this.dailyCap.sell_usd),
    };
  }

  get isEnabled(): boolean { return this.enabled; }

  // ─── Internal ─────────────────────────────────────────────────────

  private async executeDirectly(order: TradeOrder): Promise<ExecutionResult> {
    order.status = "executing";
    this.logger.info(
      { order_id: order.id, action: order.action, amount: order.amount_usd, venue: order.venue },
      "Executing trade via Bankr"
    );

    try {
      // Bankr execution would go here — for now simulate
      // In production: call Bankr skill swap endpoint
      order.status = "complete";
      order.executed_at = new Date().toISOString();
      order.executed_price_usd = 0.04; // placeholder
      order.executed_amount_regen = order.action === "buy" ? order.amount_usd / 0.04 : 0;
      order.gas_cost_usd = order.chain === "base" ? 0.01 : 0.05;

      // Update daily cap
      if (order.action === "buy") this.dailyCap.buy_usd += order.amount_usd;
      else this.dailyCap.sell_usd += order.amount_usd;
      this.saveDailyCap();

      this.logger.info({ order_id: order.id, tx_hash: order.tx_hash }, "Trade executed successfully");
      return { success: true, order };
    } catch (err) {
      order.status = "failed";
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error({ order_id: order.id, error: errMsg }, "Trade execution failed");
      return { success: false, order, error: errMsg };
    }
  }

  private refreshDailyCap(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyCap.date !== today) {
      this.dailyCap = { date: today, buy_usd: 0, sell_usd: 0 };
      this.saveDailyCap();
    }
  }

  private loadDailyCap(): DailyCap {
    try {
      if (!fs.existsSync(this.capPath)) return { date: new Date().toISOString().slice(0, 10), buy_usd: 0, sell_usd: 0 };
      const data = JSON.parse(fs.readFileSync(this.capPath, "utf-8")) as DailyCap;
      const today = new Date().toISOString().slice(0, 10);
      if (data.date !== today) return { date: today, buy_usd: 0, sell_usd: 0 };
      return data;
    } catch { return { date: new Date().toISOString().slice(0, 10), buy_usd: 0, sell_usd: 0 }; }
  }

  private saveDailyCap(): void {
    try {
      const dir = path.dirname(this.capPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.capPath, JSON.stringify(this.dailyCap, null, 2), "utf-8");
    } catch {}
  }
}
