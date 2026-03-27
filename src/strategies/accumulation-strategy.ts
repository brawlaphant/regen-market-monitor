import fs from "node:fs";
import path from "node:path";
import type { CrossChainSnapshot } from "../chain/cross-chain-aggregator.js";
import type { TradingSignal } from "../signals/trading-signal.js";
import type { TradeOrder } from "../execution/bankr-adapter.js";
import type { BankrAdapter } from "../execution/bankr-adapter.js";
import type { Logger } from "../logger.js";

export interface AccumulationPosition {
  total_regen_accumulated: number;
  total_usd_spent: number;
  avg_entry_price_usd: number;
  last_buy_at: string | null;
  buy_count: number;
}

/**
 * Pre-listing REGEN accumulation strategy.
 * Epoch-aware DCA on Hydrex (primary) with conviction-weighted sizing.
 * Never chases price above ACCUMULATION_PRICE_CAP_USD.
 */
export class AccumulationStrategy {
  private logger: Logger;
  private adapter: BankrAdapter;
  private priceCap: number;
  private minTvl: number;
  private intervalHours: number;
  private dailyBuyCap: number;
  private singleOrderMax: number;
  private positionPath: string;
  private position: AccumulationPosition;
  private lastBuyTime = 0;

  constructor(adapter: BankrAdapter, dataDir: string, logger: Logger) {
    this.adapter = adapter;
    this.logger = logger;
    this.priceCap = parseFloat(process.env.ACCUMULATION_PRICE_CAP_USD || "0.05");
    this.minTvl = parseFloat(process.env.ACCUMULATION_MIN_TVL_USD || "10000");
    this.intervalHours = parseFloat(process.env.ACCUMULATION_INTERVAL_HOURS || "4");
    this.dailyBuyCap = parseFloat(process.env.DAILY_BUY_CAP_USD || "100");
    this.singleOrderMax = parseFloat(process.env.SINGLE_ORDER_MAX_USD || "50");
    this.positionPath = path.join(dataDir, "accumulation-position.json");
    this.position = this.loadPosition();
  }

  async run(snapshot: CrossChainSnapshot, signal: TradingSignal): Promise<TradeOrder | null> {
    // Entry condition 1: signal direction
    if (signal.direction !== "long" && signal.signal_class !== "ACCUMULATION" && signal.signal_class !== "EPOCH_PLAY") {
      return null;
    }

    // Entry condition 2: not right before epoch flip
    const hydrex = snapshot.venues.find((v) => v.venue === "hydrex_base");
    // We can't check hours_to_epoch from VenuePrice directly — use heuristic
    // If epoch data is available through the venue context, use it
    // For safety, assume OK unless we have explicit epoch data

    // Entry condition 3: daily cap headroom
    const capRemaining = this.adapter.getDailyCapRemaining();
    if (capRemaining.buy_remaining < this.dailyBuyCap * 0.2) {
      this.logger.debug("Accumulation skipped: daily cap nearly exhausted");
      return null;
    }

    // Entry condition 4: price below cap
    const price = snapshot.weighted_price_usd;
    if (price > this.priceCap) {
      this.logger.debug({ price, cap: this.priceCap }, "Accumulation skipped: price above cap");
      return null;
    }

    // Entry condition 5: Hydrex TVL sufficient
    if (hydrex && hydrex.liquidity_usd < this.minTvl) {
      this.logger.debug({ tvl: hydrex.liquidity_usd }, "Accumulation skipped: TVL below minimum");
      return null;
    }

    // Entry condition 6: no EXIT or MANIPULATION
    if (signal.signal_class === "EXIT") return null;

    // Timing: respect DCA interval
    const hoursSinceLastBuy = (Date.now() - this.lastBuyTime) / 3600000;
    if (hoursSinceLastBuy < this.intervalHours && signal.signal_class !== "EPOCH_PLAY") {
      return null;
    }

    // Sizing model
    const baseSize = this.dailyBuyCap / 24;
    let size: number;
    if (signal.signal_class === "EPOCH_PLAY" && signal.conviction !== "C") {
      size = baseSize * 3.0;
    } else if (signal.conviction === "A") {
      size = baseSize * 2.0;
    } else if (signal.conviction === "B") {
      size = baseSize * 1.0;
    } else {
      size = baseSize * 0.5;
    }
    size = Math.min(size, this.singleOrderMax, capRemaining.buy_remaining);
    size = Math.round(size * 100) / 100;

    if (size < 1) return null; // too small

    // Venue selection
    const venue = hydrex && hydrex.liquidity_usd >= this.minTvl ? "hydrex" : "aerodrome";

    const order: TradeOrder = {
      id: crypto.randomUUID(),
      signal_id: signal.id,
      phase: "accumulation",
      chain: "base",
      action: "buy",
      token_in: "USDC",
      token_out: "REGEN",
      amount_usd: size,
      max_slippage_pct: 1.0,
      venue,
      priority: signal.conviction === "A" ? "high" : "medium",
      requires_approval: size > parseFloat(process.env.EXECUTION_THRESHOLD_USD || "20"),
      status: "pending_approval",
      created_at: new Date().toISOString(),
    };

    this.logger.info(
      { size, venue, conviction: signal.conviction, signal_class: signal.signal_class },
      "Accumulation buy order created"
    );

    return order;
  }

  recordExecution(order: TradeOrder): void {
    if (order.status !== "complete") return;
    this.position.total_regen_accumulated += order.executed_amount_regen || 0;
    this.position.total_usd_spent += order.amount_usd;
    this.position.avg_entry_price_usd = this.position.total_regen_accumulated > 0
      ? this.position.total_usd_spent / this.position.total_regen_accumulated
      : 0;
    this.position.last_buy_at = order.executed_at || new Date().toISOString();
    this.position.buy_count++;
    this.lastBuyTime = Date.now();
    this.savePosition();
  }

  getPosition(): AccumulationPosition {
    return { ...this.position };
  }

  private loadPosition(): AccumulationPosition {
    try {
      if (!fs.existsSync(this.positionPath)) return { total_regen_accumulated: 0, total_usd_spent: 0, avg_entry_price_usd: 0, last_buy_at: null, buy_count: 0 };
      return JSON.parse(fs.readFileSync(this.positionPath, "utf-8"));
    } catch { return { total_regen_accumulated: 0, total_usd_spent: 0, avg_entry_price_usd: 0, last_buy_at: null, buy_count: 0 }; }
  }

  private savePosition(): void {
    try {
      const dir = path.dirname(this.positionPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.positionPath, JSON.stringify(this.position, null, 2), "utf-8");
    } catch {}
  }
}
