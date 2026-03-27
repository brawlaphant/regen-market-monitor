import type { PriceDataset, PricePoint } from "./history-collector.js";
import type { SignalClass, TradingSignal } from "../signals/trading-signal.js";
import { SIGNAL_CLASSES } from "../signals/trading-signal.js";
import type { Logger } from "../logger.js";

export interface BacktestConfig {
  signal_classes: SignalClass[];
  conviction_filter: "A" | "B" | "C" | "all";
  start_date?: string;
  end_date?: string;
  initial_capital_usd: number;
  position_size_pct: number;
  stop_loss_pct: number;
}

export interface BacktestResult {
  total_signals: number;
  signals_by_class: Record<string, number>;
  signals_by_conviction: { A: number; B: number; C: number };
  win_rate_overall: number;
  win_rate_by_class: Record<string, number>;
  win_rate_by_conviction: { A: number; B: number; C: number };
  avg_return_per_signal: number;
  best_signal_class: string;
  worst_signal_class: string;
  max_drawdown_pct: number;
  equity_curve: { timestamp: string; capital_usd: number }[];
  sharpe_ratio: number;
  total_return_pct: number;
  false_positive_rate: number;
  avg_holding_hours: number;
  disclaimer: string;
}

interface OpenPosition {
  signal_class: SignalClass;
  conviction: string;
  direction: "long" | "short";
  entry_price: number;
  target_price: number;
  stop_price: number;
  entry_time: string;
  expiry_time: string;
  size_pct: number;
}

interface ClosedPosition extends OpenPosition {
  exit_price: number;
  exit_time: string;
  return_pct: number;
  outcome: "win" | "loss" | "expired";
}

const DISCLAIMER = "This backtest uses simulated historical data. Past performance does not predict future results. All figures are hypothetical. No real capital was used or implied.";

/**
 * Replays historical price data against the signal model.
 * Never touches real execution or Bankr.
 */
export class BacktestRunner {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  run(dataset: PriceDataset, config: BacktestConfig): BacktestResult {
    const points = this.filterByDate(dataset.points, config.start_date, config.end_date);
    if (points.length < 48) {
      return this.emptyResult("Insufficient data (< 48 hours)");
    }

    let capital = config.initial_capital_usd;
    let peak = capital;
    let maxDrawdown = 0;
    const openPositions: OpenPosition[] = [];
    const closedPositions: ClosedPosition[] = [];
    const equityCurve: { timestamp: string; capital_usd: number }[] = [];

    for (let i = 24; i < points.length; i++) {
      const current = points[i];
      const price = current.price_usd;

      // Check open positions
      for (let j = openPositions.length - 1; j >= 0; j--) {
        const pos = openPositions[j];
        let closed = false;
        let exitPrice = price;
        let outcome: "win" | "loss" | "expired" = "expired";

        if (pos.direction === "long") {
          if (price >= pos.target_price) { exitPrice = pos.target_price; outcome = "win"; closed = true; }
          else if (price <= pos.stop_price) { exitPrice = pos.stop_price; outcome = "loss"; closed = true; }
        } else {
          if (price <= pos.target_price) { exitPrice = pos.target_price; outcome = "win"; closed = true; }
          else if (price >= pos.stop_price) { exitPrice = pos.stop_price; outcome = "loss"; closed = true; }
        }

        if (new Date(current.timestamp) >= new Date(pos.expiry_time)) closed = true;

        if (closed) {
          const returnPct = pos.direction === "long"
            ? (exitPrice - pos.entry_price) / pos.entry_price
            : (pos.entry_price - exitPrice) / pos.entry_price;
          capital *= (1 + returnPct * pos.size_pct);
          closedPositions.push({ ...pos, exit_price: exitPrice, exit_time: current.timestamp, return_pct: returnPct * 100, outcome });
          openPositions.splice(j, 1);
        }
      }

      // Generate simulated signal every 4 hours
      if (i % 4 === 0 && openPositions.length === 0) {
        const lookback = points.slice(Math.max(0, i - 24), i);
        const signal = this.simulateSignal(lookback, price, config);
        if (signal && this.matchesFilter(signal, config)) {
          const target = signal.direction === "long"
            ? price * 1.03 : price * 0.97;
          const stop = signal.direction === "long"
            ? price * (1 - config.stop_loss_pct) : price * (1 + config.stop_loss_pct);
          openPositions.push({
            signal_class: signal.signal_class,
            conviction: signal.conviction,
            direction: signal.direction,
            entry_price: price,
            target_price: target,
            stop_price: stop,
            entry_time: current.timestamp,
            expiry_time: new Date(new Date(current.timestamp).getTime() + 4 * 3600000).toISOString(),
            size_pct: config.position_size_pct,
          });
        }
      }

      // Track equity
      if (capital > peak) peak = capital;
      const dd = ((peak - capital) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
      equityCurve.push({ timestamp: current.timestamp, capital_usd: Math.round(capital * 100) / 100 });
    }

    return this.buildResult(closedPositions, equityCurve, maxDrawdown, config.initial_capital_usd, capital);
  }

  private simulateSignal(lookback: PricePoint[], currentPrice: number, config: BacktestConfig): { signal_class: SignalClass; conviction: "A" | "B" | "C"; direction: "long" | "short" } | null {
    if (lookback.length < 5) return null;
    const avgPrice = lookback.reduce((s, p) => s + p.price_usd, 0) / lookback.length;
    const pctChange = (currentPrice - avgPrice) / avgPrice;

    if (Math.abs(pctChange) < 0.01) return null; // no signal

    const direction = pctChange > 0 ? "long" as const : "short" as const;
    const conviction = Math.abs(pctChange) > 0.05 ? "A" as const : Math.abs(pctChange) > 0.02 ? "B" as const : "C" as const;
    const cls = direction === "long" ? "MOMENTUM_LONG" as const : "MOMENTUM_SHORT" as const;

    return { signal_class: cls, conviction, direction };
  }

  private matchesFilter(signal: { conviction: string; signal_class: string }, config: BacktestConfig): boolean {
    if (config.conviction_filter !== "all" && signal.conviction !== config.conviction_filter) return false;
    if (!config.signal_classes.includes(signal.signal_class as SignalClass)) return false;
    return true;
  }

  private filterByDate(points: PricePoint[], start?: string, end?: string): PricePoint[] {
    return points.filter((p) => {
      const t = new Date(p.timestamp).getTime();
      if (start && t < new Date(start).getTime()) return false;
      if (end && t > new Date(end).getTime()) return false;
      return true;
    });
  }

  private buildResult(closed: ClosedPosition[], curve: { timestamp: string; capital_usd: number }[], maxDD: number, initial: number, final: number): BacktestResult {
    const wins = closed.filter((p) => p.outcome === "win");
    const byClass: Record<string, number> = {};
    const winsByClass: Record<string, number> = {};
    const totalByClass: Record<string, number> = {};
    const byConviction = { A: 0, B: 0, C: 0 };
    const winsByConviction = { A: 0, B: 0, C: 0 };

    for (const p of closed) {
      byClass[p.signal_class] = (byClass[p.signal_class] || 0) + 1;
      totalByClass[p.signal_class] = (totalByClass[p.signal_class] || 0) + 1;
      if (p.outcome === "win") winsByClass[p.signal_class] = (winsByClass[p.signal_class] || 0) + 1;
      const c = p.conviction as "A" | "B" | "C";
      if (c in byConviction) { byConviction[c]++; if (p.outcome === "win") winsByConviction[c]++; }
    }

    const winRateByClass: Record<string, number> = {};
    for (const [cls, total] of Object.entries(totalByClass)) {
      winRateByClass[cls] = total > 0 ? Math.round(((winsByClass[cls] || 0) / total) * 100) : 0;
    }

    const avgReturn = closed.length > 0 ? closed.reduce((s, p) => s + p.return_pct, 0) / closed.length : 0;
    const totalReturn = ((final - initial) / initial) * 100;
    const returns = closed.map((p) => p.return_pct);
    const meanReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const stdReturn = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1)) : 1;
    const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(365) : 0;

    const best = Object.entries(winRateByClass).sort((a, b) => b[1] - a[1])[0];
    const worst = Object.entries(winRateByClass).sort((a, b) => a[1] - b[1])[0];
    const fps = closed.filter((p) => p.outcome === "loss").length;
    const holdingHours = closed.map((p) => (new Date(p.exit_time).getTime() - new Date(p.entry_time).getTime()) / 3600000);

    return {
      total_signals: closed.length,
      signals_by_class: byClass,
      signals_by_conviction: byConviction,
      win_rate_overall: closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0,
      win_rate_by_class: winRateByClass,
      win_rate_by_conviction: {
        A: byConviction.A > 0 ? Math.round((winsByConviction.A / byConviction.A) * 100) : 0,
        B: byConviction.B > 0 ? Math.round((winsByConviction.B / byConviction.B) * 100) : 0,
        C: byConviction.C > 0 ? Math.round((winsByConviction.C / byConviction.C) * 100) : 0,
      },
      avg_return_per_signal: Math.round(avgReturn * 100) / 100,
      best_signal_class: best?.[0] || "HOLD",
      worst_signal_class: worst?.[0] || "HOLD",
      max_drawdown_pct: Math.round(maxDD * 100) / 100,
      equity_curve: curve.filter((_, i) => i % 24 === 0), // daily points only
      sharpe_ratio: Math.round(sharpe * 100) / 100,
      total_return_pct: Math.round(totalReturn * 100) / 100,
      false_positive_rate: closed.length > 0 ? Math.round((fps / closed.length) * 100) : 0,
      avg_holding_hours: holdingHours.length > 0 ? Math.round(holdingHours.reduce((s, h) => s + h, 0) / holdingHours.length * 10) / 10 : 0,
      disclaimer: DISCLAIMER,
    };
  }

  private emptyResult(reason: string): BacktestResult {
    return {
      total_signals: 0, signals_by_class: {}, signals_by_conviction: { A: 0, B: 0, C: 0 },
      win_rate_overall: 0, win_rate_by_class: {}, win_rate_by_conviction: { A: 0, B: 0, C: 0 },
      avg_return_per_signal: 0, best_signal_class: "HOLD", worst_signal_class: "HOLD",
      max_drawdown_pct: 0, equity_curve: [], sharpe_ratio: 0, total_return_pct: 0,
      false_positive_rate: 0, avg_holding_hours: 0, disclaimer: `${DISCLAIMER}\n${reason}`,
    };
  }
}
