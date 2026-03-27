import type { TradingSignal } from "./trading-signal.js";
import type { CrossChainSnapshot } from "../chain/cross-chain-aggregator.js";
import type { MarketSignal } from "./signal-schema.js";
import type { Logger } from "../logger.js";

/**
 * Checks active trading signals for invalidation conditions.
 * On invalidation: updates signal in-place, returns list of invalidated signals.
 */
export class SignalInvalidator {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  checkAll(
    activeSignals: TradingSignal[],
    snapshot: CrossChainSnapshot,
    recentMarketSignals: MarketSignal[]
  ): TradingSignal[] {
    const invalidated: TradingSignal[] = [];

    for (const signal of activeSignals) {
      if (signal.invalidated) continue;

      const reason = this.checkInvalidation(signal, snapshot, recentMarketSignals);
      if (reason) {
        signal.invalidated = true;
        signal.invalidated_reason = reason;
        invalidated.push(signal);
        this.logger.info(
          { signal_id: signal.id, class: signal.signal_class, reason },
          "Trading signal invalidated"
        );
      }
    }

    return invalidated;
  }

  private checkInvalidation(
    signal: TradingSignal,
    snapshot: CrossChainSnapshot,
    recentSignals: MarketSignal[]
  ): string | null {
    const currentPrice = snapshot.weighted_price_usd;
    if (currentPrice <= 0) return null;

    // Price moved > 3% against direction
    if (signal.direction === "long" && signal.entry_price_usd > 0) {
      const pctMove = (currentPrice - signal.entry_price_usd) / signal.entry_price_usd;
      if (pctMove < -0.03) return `Price moved ${(pctMove * 100).toFixed(1)}% against long position`;
    }
    if (signal.direction === "short" && signal.entry_price_usd > 0) {
      const pctMove = (currentPrice - signal.entry_price_usd) / signal.entry_price_usd;
      if (pctMove > 0.03) return `Price moved +${(pctMove * 100).toFixed(1)}% against short position`;
    }

    // Arbitrage spread closed
    if (signal.signal_class === "ARBITRAGE_LONG") {
      if (!snapshot.arbitrage_opportunity || snapshot.spread_pct < 0.5) {
        return "Arbitrage spread closed (< 0.5%)";
      }
    }

    // Epoch flipped (EPOCH_PLAY)
    if (signal.signal_class === "EPOCH_PLAY") {
      // If we no longer have epoch transition signals, epoch may have flipped
      const epochSignals = recentSignals.filter((s) => s.signal_type === "HYDX_EPOCH_TRANSITION");
      if (epochSignals.length === 0) {
        return "Epoch may have flipped — no active epoch transition signals";
      }
    }

    // MANIPULATION_ALERT fired after signal
    const manipAlert = recentSignals.find(
      (s) => s.signal_type === "MANIPULATION_ALERT" && new Date(s.timestamp) > new Date(signal.generated_at)
    );
    if (manipAlert) return "MANIPULATION_ALERT fired after signal generation";

    // Primary venue offline
    const entryVenueOnline = snapshot.venues.some((v) => v.venue === signal.entry_venue && v.price_usd > 0);
    if (!entryVenueOnline && signal.entry_venue !== "best") {
      return `Entry venue ${signal.entry_venue} went offline`;
    }

    // Bridge flow reversed
    if (signal.signal_class === "ACCUMULATION" && snapshot.bridge_flow.signal === "distribution") {
      return "Bridge flow reversed from accumulation to distribution";
    }
    if (signal.signal_class === "DISTRIBUTION" && snapshot.bridge_flow.signal === "accumulation") {
      return "Bridge flow reversed from distribution to accumulation";
    }

    return null;
  }
}
