import fs from "node:fs";
import path from "node:path";
import type { TradingSignal, SignalClass } from "./trading-signal.js";
import type { Logger } from "../logger.js";

const DEFAULT_MAX = 200;

/**
 * In-memory ring buffer for trading signals with JSONL persistence.
 */
export class TradingSignalStore {
  private buffer: TradingSignal[] = [];
  private maxSize: number;
  private filePath: string;
  private logger: Logger;

  constructor(dataDir: string, logger: Logger) {
    this.maxSize = DEFAULT_MAX;
    this.filePath = path.join(dataDir, "trading-signals.jsonl");
    this.logger = logger;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.loadFromDisk();
  }

  push(signal: TradingSignal): void {
    this.buffer.push(signal);
    if (this.buffer.length > this.maxSize) this.buffer = this.buffer.slice(-this.maxSize);
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(signal) + "\n", "utf-8");
    } catch (err) {
      this.logger.error({ err }, "Failed to persist trading signal");
    }
  }

  getActive(): TradingSignal[] {
    const now = Date.now();
    return this.buffer.filter(
      (s) => !s.invalidated && new Date(s.expiry_at).getTime() > now
    );
  }

  getRecent(limit = 20, filters?: {
    conviction?: string;
    direction?: string;
    signal_class?: string;
    active_only?: boolean;
  }): TradingSignal[] {
    let results = [...this.buffer].reverse();

    if (filters?.conviction) results = results.filter((s) => s.conviction === filters.conviction);
    if (filters?.direction) results = results.filter((s) => s.direction === filters.direction);
    if (filters?.signal_class) results = results.filter((s) => s.signal_class === filters.signal_class);
    if (filters?.active_only) {
      const now = Date.now();
      results = results.filter((s) => !s.invalidated && new Date(s.expiry_at).getTime() > now);
    }

    return results.slice(0, limit);
  }

  getByClass(cls: SignalClass): TradingSignal[] {
    return this.buffer.filter((s) => s.signal_class === cls);
  }

  getById(id: string): TradingSignal | undefined {
    return this.buffer.find((s) => s.id === id);
  }

  /** Most recent non-expired signal of each class */
  getLatestPerClass(): TradingSignal[] {
    const now = Date.now();
    const seen = new Set<string>();
    const result: TradingSignal[] = [];
    for (const s of [...this.buffer].reverse()) {
      if (!seen.has(s.signal_class) && !s.invalidated && new Date(s.expiry_at).getTime() > now) {
        seen.add(s.signal_class);
        result.push(s);
      }
    }
    return result;
  }

  getStats(): Record<string, unknown> {
    const now = Date.now();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    const active = this.buffer.filter((s) => !s.invalidated && new Date(s.expiry_at).getTime() > now);
    const todaySignals = this.buffer.filter((s) => new Date(s.generated_at).getTime() > todayMs);
    const aToday = todaySignals.filter((s) => s.conviction === "A");

    const byClass: Record<string, number> = {};
    const byConviction: Record<string, number> = {};
    const byDirection: Record<string, number> = {};
    for (const s of this.buffer) {
      byClass[s.signal_class] = (byClass[s.signal_class] || 0) + 1;
      byConviction[s.conviction] = (byConviction[s.conviction] || 0) + 1;
      byDirection[s.direction] = (byDirection[s.direction] || 0) + 1;
    }

    return {
      total: this.buffer.length,
      by_class: byClass,
      by_conviction: byConviction,
      by_direction: byDirection,
      active_count: active.length,
      signals_today: todaySignals.length,
      a_signals_today: aToday.length,
    };
  }

  /** Hypothetical performance analysis on expired signals */
  getPerformance(currentPrice: number): Record<string, unknown> {
    const now = Date.now();
    const expired = this.buffer.filter(
      (s) => new Date(s.expiry_at).getTime() <= now && s.entry_price_usd > 0 && s.direction !== "neutral"
    );

    if (expired.length === 0) return { total_expired: 0 };

    let correctDirection = 0;
    let totalReturn = 0;
    let best = { id: "", return_pct: -Infinity };
    let worst = { id: "", return_pct: Infinity };
    let aCorrect = 0;
    let aTotal = 0;
    let bCorrect = 0;
    let bTotal = 0;

    for (const s of expired) {
      // Use target_price as proxy for hypothetical exit (or current price for recent)
      const exitPrice = currentPrice;
      const returnPct = s.direction === "long"
        ? ((exitPrice - s.entry_price_usd) / s.entry_price_usd) * 100
        : ((s.entry_price_usd - exitPrice) / s.entry_price_usd) * 100;

      totalReturn += returnPct;
      if (returnPct > 0) correctDirection++;
      if (returnPct > best.return_pct) best = { id: s.id, return_pct: returnPct };
      if (returnPct < worst.return_pct) worst = { id: s.id, return_pct: returnPct };

      if (s.conviction === "A") { aTotal++; if (returnPct > 0) aCorrect++; }
      if (s.conviction === "B") { bTotal++; if (returnPct > 0) bCorrect++; }
    }

    return {
      total_expired: expired.length,
      direction_accuracy_pct: Math.round((correctDirection / expired.length) * 100),
      avg_return_if_followed_pct: Math.round((totalReturn / expired.length) * 100) / 100,
      best_signal: best.return_pct > -Infinity ? best : null,
      worst_signal: worst.return_pct < Infinity ? worst : null,
      conviction_a_accuracy: aTotal > 0 ? Math.round((aCorrect / aTotal) * 100) : null,
      conviction_b_accuracy: bTotal > 0 ? Math.round((bCorrect / bTotal) * 100) : null,
      disclaimer: "Hypothetical returns based on entry price vs current price. Not actual trading results.",
    };
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const lines = fs.readFileSync(this.filePath, "utf-8").split("\n").filter(Boolean);
      const recent = lines.slice(-this.maxSize);
      const now = Date.now();
      for (const line of recent) {
        try {
          const s = JSON.parse(line) as TradingSignal;
          if (s.version !== "1.0") continue;
          // Mark expired on load
          if (new Date(s.expiry_at).getTime() <= now && !s.invalidated) {
            s.invalidated = true;
            s.invalidated_reason = "Expired before reload";
          }
          this.buffer.push(s);
        } catch {}
      }
      this.logger.info({ loaded: this.buffer.length }, "Trading signals loaded from disk");
    } catch {}
  }
}
