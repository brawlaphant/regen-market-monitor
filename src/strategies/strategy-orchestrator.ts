import fs from "node:fs";
import path from "node:path";
import { AccumulationStrategy } from "./accumulation-strategy.js";
import { CoinstoreVolumeStrategy } from "./coinstore-volume-strategy.js";
import { BankrAdapter } from "../execution/bankr-adapter.js";
import { ExecutionLedger } from "../execution/execution-ledger.js";
import type { CrossChainSnapshot } from "../chain/cross-chain-aggregator.js";
import type { TradingSignal } from "../signals/trading-signal.js";
import type { Logger } from "../logger.js";

/**
 * Runs accumulation and Coinstore strategies in coordination.
 * Prevents conflicts between buy and sell actions.
 */
export class StrategyOrchestrator {
  private accumulation: AccumulationStrategy;
  private coinstore: CoinstoreVolumeStrategy;
  private adapter: BankrAdapter;
  private ledger: ExecutionLedger;
  private logger: Logger;
  private logPath: string;
  private pendingAccumulation = false;

  constructor(
    adapter: BankrAdapter,
    ledger: ExecutionLedger,
    dataDir: string,
    logger: Logger
  ) {
    this.adapter = adapter;
    this.ledger = ledger;
    this.logger = logger;
    this.logPath = path.join(dataDir, "strategy-log.jsonl");
    this.accumulation = new AccumulationStrategy(adapter, dataDir, logger);
    this.coinstore = new CoinstoreVolumeStrategy(logger);
  }

  get accumulationStrategy(): AccumulationStrategy { return this.accumulation; }
  get coinstoreStrategy(): CoinstoreVolumeStrategy { return this.coinstore; }

  async run(snapshot: CrossChainSnapshot, signal: TradingSignal): Promise<void> {
    const decision: Record<string, unknown> = { timestamp: new Date().toISOString(), signal_class: signal.signal_class, conviction: signal.conviction };

    // 1. Check Coinstore health
    let coinstoreHealth = null;
    if (this.coinstore.isConfigured) {
      coinstoreHealth = await this.coinstore.getMarketHealth();
    }

    // 2. If Coinstore health critical, prioritize MM
    if (coinstoreHealth && coinstoreHealth.health_score < 0.4) {
      decision.action = "coinstore_priority";
      await this.coinstore.placeMarketMakingOrders(snapshot.weighted_price_usd);

      // Volume boost if below minimum
      if (coinstoreHealth.volume_24h_usdt < parseFloat(process.env.COINSTORE_MIN_DAILY_VOLUME_USDT || "500")) {
        await this.coinstore.runVolumeBoost();
      }

      this.logDecision(decision);
      return; // Skip accumulation when Coinstore needs attention
    }

    // 3. Run accumulation strategy (conflict check: no sell pending)
    if (!this.pendingAccumulation) {
      const order = await this.accumulation.run(snapshot, signal);
      if (order) {
        decision.action = "accumulation";
        decision.order_size = order.amount_usd;

        const result = await this.adapter.execute(order);
        if (result.success && order.status === "complete") {
          this.accumulation.recordExecution(order);
          this.ledger.record(order, "accumulation");
        }
      } else {
        decision.action = "no_accumulation";
      }
    }

    // 4. Refresh Coinstore MM if configured and interval elapsed
    if (this.coinstore.isConfigured) {
      await this.coinstore.placeMarketMakingOrders(snapshot.weighted_price_usd);
    }

    this.logDecision(decision);
  }

  private logDecision(decision: Record<string, unknown>): void {
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(decision) + "\n", "utf-8");
    } catch {}
  }
}
