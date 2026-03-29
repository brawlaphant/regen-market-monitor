/**
 * Surplus Router
 *
 * The economic loop: trade across venues → earn P&L → route surplus to REGEN accumulation → retire ecocredits.
 *
 * When cumulative P&L exceeds the surplus floor, a configured percentage gets
 * routed to extra REGEN accumulation (via BankrAdapter or direct buys).
 * Trading profits pay bills first; surplus accumulates REGEN.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface VenuePnl {
  venue: string;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  trades_today: number;
  spent_usd: number;
}

export interface PnlState {
  date: string;
  venues: Record<string, VenuePnl>;
  cumulative_realized_usd: number;
  cumulative_surplus_routed_usd: number;
  last_updated: string;
}

export interface SurplusAllocation {
  available_surplus_usd: number;
  routed_to_regen_usd: number;
  reason: string;
}

export class SurplusRouter {
  private logger: Logger;
  private dataDir: string;
  private state: PnlState;
  private surplusFloor: number;
  private surplusPct: number;

  constructor(dataDir: string, logger: Logger) {
    this.logger = logger;
    this.dataDir = dataDir;
    this.surplusFloor = parseFloat(process.env.TRADING_DESK_SURPLUS_FLOOR || "50");
    this.surplusPct = parseFloat(process.env.TRADING_DESK_SURPLUS_PCT || "20") / 100;
    this.state = this.loadState();
  }

  /** Record P&L from a venue run */
  recordVenuePnl(venue: string, realized: number, unrealized: number, trades: number, spent: number): void {
    this.refreshDate();
    const existing = this.state.venues[venue] || {
      venue, realized_pnl_usd: 0, unrealized_pnl_usd: 0, trades_today: 0, spent_usd: 0,
    };

    existing.realized_pnl_usd += realized;
    existing.unrealized_pnl_usd = unrealized; // snapshot, not cumulative
    existing.trades_today += trades;
    existing.spent_usd += spent;
    this.state.venues[venue] = existing;

    this.state.cumulative_realized_usd += realized;
    this.state.last_updated = new Date().toISOString();
    this.saveState();

    this.logger.info(
      { venue, realized, cumulative: this.state.cumulative_realized_usd },
      "Venue P&L recorded"
    );
  }

  /** Calculate how much surplus should be routed to REGEN accumulation */
  calculateSurplus(): SurplusAllocation {
    const cumPnl = this.state.cumulative_realized_usd;
    const alreadyRouted = this.state.cumulative_surplus_routed_usd;
    const netPnl = cumPnl - alreadyRouted;

    if (netPnl <= this.surplusFloor) {
      return {
        available_surplus_usd: 0,
        routed_to_regen_usd: 0,
        reason: `P&L ($${netPnl.toFixed(2)}) below surplus floor ($${this.surplusFloor})`,
      };
    }

    const surplus = netPnl - this.surplusFloor;
    const toRoute = Math.round(surplus * this.surplusPct * 100) / 100;

    return {
      available_surplus_usd: surplus,
      routed_to_regen_usd: toRoute,
      reason: `${(this.surplusPct * 100).toFixed(0)}% of $${surplus.toFixed(2)} surplus → $${toRoute.toFixed(2)} to REGEN`,
    };
  }

  /** Mark surplus as routed (after successful REGEN accumulation) */
  markRouted(amount: number): void {
    this.state.cumulative_surplus_routed_usd += amount;
    this.state.last_updated = new Date().toISOString();
    this.saveState();
    this.logger.info({ amount, total_routed: this.state.cumulative_surplus_routed_usd }, "Surplus routed to REGEN");
  }

  /** Get current P&L state */
  getState(): PnlState {
    this.refreshDate();
    return { ...this.state };
  }

  /** Get today's aggregate P&L across all venues */
  getTodayPnl(): { realized: number; unrealized: number; trades: number; spent: number } {
    this.refreshDate();
    let realized = 0, unrealized = 0, trades = 0, spent = 0;
    for (const v of Object.values(this.state.venues)) {
      realized += v.realized_pnl_usd;
      unrealized += v.unrealized_pnl_usd;
      trades += v.trades_today;
      spent += v.spent_usd;
    }
    return { realized, unrealized, trades, spent };
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private refreshDate(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.date !== today) {
      // Reset daily counters, keep cumulative
      for (const v of Object.values(this.state.venues)) {
        v.realized_pnl_usd = 0;
        v.unrealized_pnl_usd = 0;
        v.trades_today = 0;
        v.spent_usd = 0;
      }
      this.state.date = today;
      this.saveState();
    }
  }

  private loadState(): PnlState {
    const file = path.join(this.dataDir, "pnl-state.json");
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, "utf-8")) as PnlState;
      }
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Corrupt P&L state — starting fresh");
    }
    return {
      date: new Date().toISOString().slice(0, 10),
      venues: {},
      cumulative_realized_usd: 0,
      cumulative_surplus_routed_usd: 0,
      last_updated: new Date().toISOString(),
    };
  }

  private saveState(): void {
    try {
      const dir = this.dataDir;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "pnl-state.json");
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "P&L state save failed");
    }
  }
}
