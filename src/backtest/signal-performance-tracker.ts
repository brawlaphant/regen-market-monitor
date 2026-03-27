import fs from "node:fs";
import path from "node:path";
import type { TradingSignal } from "../signals/trading-signal.js";
import type { Logger } from "../logger.js";

interface TrackedSignal {
  signal_id: string;
  signal_class: string;
  conviction: string;
  direction: string;
  entry_price: number;
  entry_time: string;
  expiry_at: string;
  exit_price?: number;
  exit_time?: string;
  outcome?: "win" | "loss" | "expired";
  return_pct?: number;
}

/**
 * Tracks every real signal generated since deployment against actual outcomes.
 * Persists to data/signal-performance.json.
 */
export class SignalPerformanceTracker {
  private tracked: TrackedSignal[] = [];
  private filePath: string;
  private logger: Logger;
  private enabled: boolean;

  constructor(dataDir: string, logger: Logger) {
    this.filePath = path.join(dataDir, "signal-performance.json");
    this.logger = logger;
    this.enabled = process.env.SIGNAL_TRACKING_ENABLED !== "false";
    this.loadFromDisk();
  }

  trackSignal(signal: TradingSignal): void {
    if (!this.enabled || signal.direction === "neutral") return;
    this.tracked.push({
      signal_id: signal.id,
      signal_class: signal.signal_class,
      conviction: signal.conviction,
      direction: signal.direction,
      entry_price: signal.entry_price_usd,
      entry_time: signal.generated_at,
      expiry_at: signal.expiry_at,
    });
    this.saveToDisk();
  }

  updatePerformance(currentPrice: number): void {
    const now = Date.now();
    let updated = false;
    for (const t of this.tracked) {
      if (t.outcome) continue;
      if (new Date(t.expiry_at).getTime() <= now) {
        t.exit_price = currentPrice;
        t.exit_time = new Date().toISOString();
        t.return_pct = t.direction === "long"
          ? ((currentPrice - t.entry_price) / t.entry_price) * 100
          : ((t.entry_price - currentPrice) / t.entry_price) * 100;
        t.outcome = t.return_pct > 0 ? "win" : "loss";
        updated = true;
      }
    }
    if (updated) this.saveToDisk();
  }

  getLivePerformance(): Record<string, unknown> {
    const completed = this.tracked.filter((t) => t.outcome);
    const wins = completed.filter((t) => t.outcome === "win");

    const byClass: Record<string, { wins: number; total: number }> = {};
    const byConviction: Record<string, { wins: number; total: number }> = {};

    for (const t of completed) {
      if (!byClass[t.signal_class]) byClass[t.signal_class] = { wins: 0, total: 0 };
      byClass[t.signal_class].total++;
      if (t.outcome === "win") byClass[t.signal_class].wins++;

      if (!byConviction[t.conviction]) byConviction[t.conviction] = { wins: 0, total: 0 };
      byConviction[t.conviction].total++;
      if (t.outcome === "win") byConviction[t.conviction].wins++;
    }

    return {
      signals_tracked: this.tracked.length,
      signals_completed: completed.length,
      win_rate: completed.length > 0 ? Math.round((wins.length / completed.length) * 100) : null,
      avg_return: completed.length > 0 ? Math.round(completed.reduce((s, t) => s + (t.return_pct || 0), 0) / completed.length * 100) / 100 : null,
      by_class: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, { win_rate: Math.round((v.wins / v.total) * 100), total: v.total }])),
      by_conviction: Object.fromEntries(Object.entries(byConviction).map(([k, v]) => [k, { win_rate: Math.round((v.wins / v.total) * 100), total: v.total }])),
      last_updated: new Date().toISOString(),
    };
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      this.tracked = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch { this.tracked = []; }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.tracked, null, 2), "utf-8");
    } catch {}
  }
}
