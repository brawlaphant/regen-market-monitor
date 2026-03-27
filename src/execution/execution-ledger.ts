import fs from "node:fs";
import path from "node:path";
import type { TradeOrder } from "./bankr-adapter.js";
import type { Logger } from "../logger.js";

export interface LedgerEntry {
  id: string;
  timestamp: string;
  phase: string;
  chain: string;
  action: string;
  token_in: string;
  token_out: string;
  amount_usd: number;
  amount_regen: number;
  price_usd: number;
  tx_hash: string;
  gas_usd: number;
  venue: string;
  signal_id: string;
  strategy: string;
  success: boolean;
  error?: string;
}

/**
 * Append-only execution ledger. Never deletes or rewrites entries.
 */
export class ExecutionLedger {
  private filePath: string;
  private logger: Logger;
  private entries: LedgerEntry[] = [];

  constructor(dataDir: string, logger: Logger) {
    this.filePath = path.join(dataDir, "execution-ledger.jsonl");
    this.logger = logger;
    this.loadFromDisk();
  }

  record(order: TradeOrder, strategy: string): void {
    const entry: LedgerEntry = {
      id: order.id,
      timestamp: order.executed_at || new Date().toISOString(),
      phase: order.phase,
      chain: order.chain,
      action: order.action,
      token_in: order.token_in,
      token_out: order.token_out,
      amount_usd: order.amount_usd,
      amount_regen: order.executed_amount_regen || 0,
      price_usd: order.executed_price_usd || 0,
      tx_hash: order.tx_hash || "",
      gas_usd: order.gas_cost_usd || 0,
      venue: order.venue,
      signal_id: order.signal_id,
      strategy,
      success: order.status === "complete",
      error: order.status === "failed" ? "execution_failed" : undefined,
    };

    this.entries.push(entry);
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      this.logger.error({ err }, "Failed to write execution ledger");
    }
  }

  getRecent(limit = 50, phase?: string): LedgerEntry[] {
    let results = [...this.entries].reverse();
    if (phase) results = results.filter((e) => e.phase === phase);
    return results.slice(0, limit);
  }

  getDailySummary(): Record<string, unknown> {
    const today = new Date().toISOString().slice(0, 10);
    const todayEntries = this.entries.filter((e) => e.timestamp.startsWith(today) && e.success);
    const buys = todayEntries.filter((e) => e.action === "buy");
    const sells = todayEntries.filter((e) => e.action === "sell");

    return {
      buys_count: buys.length,
      buys_usd: buys.reduce((s, e) => s + e.amount_usd, 0),
      sells_count: sells.length,
      sells_usd: sells.reduce((s, e) => s + e.amount_usd, 0),
      net_regen_change: buys.reduce((s, e) => s + e.amount_regen, 0) - sells.reduce((s, e) => s + e.amount_regen, 0),
      gas_total_usd: todayEntries.reduce((s, e) => s + e.gas_usd, 0),
      success_rate: todayEntries.length > 0 ? 100 : 0,
    };
  }

  getPositionSummary(currentPrice: number): Record<string, unknown> {
    const buys = this.entries.filter((e) => e.action === "buy" && e.success);
    const sells = this.entries.filter((e) => e.action === "sell" && e.success);
    const totalRegen = buys.reduce((s, e) => s + e.amount_regen, 0) - sells.reduce((s, e) => s + e.amount_regen, 0);
    const totalUsd = buys.reduce((s, e) => s + e.amount_usd, 0);
    const avgEntry = totalRegen > 0 ? totalUsd / totalRegen : 0;

    return {
      total_regen_held_estimate: Math.round(totalRegen),
      total_usd_deployed: Math.round(totalUsd * 100) / 100,
      avg_entry: Math.round(avgEntry * 10000) / 10000,
      unrealized_pnl_estimate: totalRegen > 0 ? Math.round(((currentPrice - avgEntry) / avgEntry) * 10000) / 100 : 0,
    };
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const lines = fs.readFileSync(this.filePath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines.slice(-500)) {
        try { this.entries.push(JSON.parse(line)); } catch {}
      }
    } catch {}
  }
}
