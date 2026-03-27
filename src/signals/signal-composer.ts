import fs from "node:fs";
import path from "node:path";
import type { CrossChainSnapshot } from "../chain/cross-chain-aggregator.js";
import type { MarketSignal } from "./signal-schema.js";
import type { TradingSignal, SignalClass, VenueContext } from "./trading-signal.js";
import { CLASS_HORIZON, HORIZON_MS } from "./trading-signal.js";
import { TradingSignalSchema } from "../schemas.js";
import type { Logger } from "../logger.js";

const DEFAULT_MAX_SIZE = 5000;

interface ScoreDimension {
  name: string;
  score: number;
  reason: string;
}

/**
 * Synthesizes all intelligence into ranked TradingSignals.
 * Never throws — returns HOLD on error.
 */
export class SignalComposer {
  private maxSize: number;
  private logger: Logger;
  private logPath: string;

  constructor(dataDir: string, logger: Logger) {
    this.maxSize = parseInt(process.env.MAX_SIGNAL_SIZE_USD || String(DEFAULT_MAX_SIZE), 10);
    this.logger = logger;
    this.logPath = path.join(dataDir, "signal-composition-log.jsonl");
  }

  compose(
    snapshot: CrossChainSnapshot,
    recentSignals: MarketSignal[]
  ): TradingSignal {
    try {
      return this.doCompose(snapshot, recentSignals);
    } catch (err) {
      this.logger.error({ err: String(err) }, "SignalComposer error — returning HOLD");
      const fallback = snapshot || {
        timestamp: new Date().toISOString(), venues: [], best_bid_venue: "none",
        best_ask_venue: "none", spread_pct: 0, weighted_price_usd: 0,
        total_liquidity_usd: 0, arbitrage_opportunity: null,
        bridge_flow: { signal: "neutral" as const, net_regen_24h: 0, net_usd_24h: 0, largest_tx: null, tx_count_24h: 0 },
      };
      return this.buildHold(fallback, [`Composition error: ${String(err)}`]);
    }
  }

  private doCompose(snapshot: CrossChainSnapshot, recentSignals: MarketSignal[]): TradingSignal {
    const dims: ScoreDimension[] = [];
    const rationale: string[] = [];
    const risks: string[] = [];
    const contributing: string[] = [];

    // Check EXIT conditions first
    const manipAlert = recentSignals.find((s) => s.signal_type === "MANIPULATION_ALERT");
    if (manipAlert) {
      contributing.push(manipAlert.id);
      return this.buildSignal("EXIT", "exit", "A", snapshot, ["MANIPULATION_ALERT active — exit all positions"], contributing, ["Market manipulation detected"], snapshot.weighted_price_usd);
    }

    const activeVenues = snapshot.venues.filter((v) => v.price_usd > 0).length;
    if (activeVenues <= 1) {
      return this.buildSignal("EXIT", "exit", "B", snapshot, ["Only 1 venue responding — insufficient data"], contributing, ["Venue connectivity failure"], snapshot.weighted_price_usd);
    }

    // Check arbitrage override
    const arb = snapshot.arbitrage_opportunity;
    if (arb && arb.profitable && arb.confidence !== "low") {
      const conv = arb.net_spread_pct > 3 ? "A" as const : "B" as const;
      const arbSignals = recentSignals.filter((s) => s.signal_type === "CROSS_CHAIN_ARBITRAGE");
      return this.buildSignal(
        "ARBITRAGE_LONG", "long", conv, snapshot,
        [`Arbitrage: buy ${arb.buy_venue} @ $${arb.buy_price_usd.toFixed(4)}, sell ${arb.sell_venue} @ $${arb.sell_price_usd.toFixed(4)} (${arb.net_spread_pct.toFixed(1)}% net)`],
        arbSignals.map((s) => s.id),
        ["Spread may close before execution", arb.notes],
        arb.buy_price_usd,
        arb.recommended_size_usd
      );
    }

    // Score dimensions
    // 1. Price momentum
    const priceVenues = snapshot.venues.filter((v) => v.price_usd > 0);
    const avgPrice = snapshot.weighted_price_usd;
    let momentumScore = 0;
    const priceSignals = recentSignals.filter((s) => s.signal_type === "PRICE_MOVEMENT");
    for (const ps of priceSignals) {
      const d = ps.data as any;
      if (d.direction === "up" && d.change_pct > 2) { momentumScore += 1; contributing.push(ps.id); }
      if (d.direction === "down" && d.change_pct > 2) { momentumScore -= 1; contributing.push(ps.id); }
    }
    if (snapshot.spread_pct > 5) { momentumScore -= 2; risks.push("Venues diverging > 5%"); }
    dims.push({ name: "momentum", score: momentumScore, reason: `${priceSignals.length} price signals` });

    // 2. Bridge flow
    let flowScore = 0;
    const flowSignal = snapshot.bridge_flow.signal;
    if (flowSignal === "accumulation") { flowScore = 2; rationale.push("Bridge accumulation (inflow)"); }
    else if (flowSignal === "distribution") { flowScore = -2; rationale.push("Bridge distribution (outflow)"); risks.push("Outflow pressure"); }
    dims.push({ name: "bridge_flow", score: flowScore, reason: flowSignal });

    // 3. Hydrex epoch
    let epochScore = 0;
    const hydrexVenue = snapshot.venues.find((v) => v.venue === "hydrex_base");
    if (hydrexVenue) {
      // Parse from recent signals
      const epochSignals = recentSignals.filter((s) => s.signal_type === "HYDX_EPOCH_TRANSITION");
      const emissionSignals = recentSignals.filter((s) => s.signal_type === "EMISSION_SHIFT");
      for (const es of epochSignals) {
        const ed = es.data as any;
        if (ed.vote_trend === "increasing" && ed.hours_until_flip < 24) epochScore += 2;
        else if (ed.vote_trend === "increasing") epochScore += 1;
        else if (ed.vote_trend === "decreasing" && ed.hours_until_flip < 24) epochScore -= 2;
        else if (ed.vote_trend === "decreasing") epochScore -= 1;
        contributing.push(es.id);
      }
      for (const em of emissionSignals) contributing.push(em.id);
    }
    dims.push({ name: "epoch", score: epochScore, reason: `Hydrex epoch context` });

    // 4. Anomaly (z-score)
    let anomalyScore = 0;
    const anomalySignals = recentSignals.filter((s) => s.signal_type === "PRICE_ANOMALY");
    for (const as_ of anomalySignals) {
      const ad = as_.data as any;
      const z = ad.z_score ?? 0;
      if (z < -2.5) anomalyScore += 2;
      else if (z < -1.5) anomalyScore += 1;
      else if (z > 2.5) anomalyScore -= 2;
      else if (z > 1.5) anomalyScore -= 1;
      contributing.push(as_.id);
    }
    dims.push({ name: "anomaly", score: anomalyScore, reason: `z-score signals` });

    // 5. Supply health
    let supplyScore = 0;
    const lowSupply = recentSignals.filter((s) => s.signal_type === "LOW_SUPPLY");
    const critLiquidity = recentSignals.filter((s) => s.signal_type === "LIQUIDITY_WARNING");
    if (lowSupply.length > 0) { supplyScore -= 1; lowSupply.forEach((s) => contributing.push(s.id)); }
    if (critLiquidity.length > 0) { supplyScore -= 2; critLiquidity.forEach((s) => contributing.push(s.id)); risks.push("Supply health critical"); }
    if (lowSupply.length === 0 && critLiquidity.length === 0) supplyScore += 1;
    dims.push({ name: "supply", score: supplyScore, reason: `${lowSupply.length} supply alerts` });

    // 6. Whale sentiment
    let whaleScore = 0;
    const whalePatterns = recentSignals.filter((s) => s.signal_type === "WHALE_PATTERN");
    const whaleMovements = recentSignals.filter((s) => s.signal_type === "WHALE_MOVEMENT");
    for (const wp of whalePatterns) {
      const wd = wp.data as any;
      if (wd.dominant_signal === "bullish" && wd.confidence > 0.8) whaleScore += 3;
      else if (wd.dominant_signal === "bullish") whaleScore += 2;
      else if (wd.dominant_signal === "bearish" && wd.confidence > 0.8) whaleScore -= 3;
      else if (wd.dominant_signal === "bearish") whaleScore -= 2;
      contributing.push(wp.id);
    }
    for (const wm of whaleMovements) {
      const wd = wm.data as any;
      if (wd.movement_type === "lp_add" || wd.movement_type === "receive") whaleScore += 1;
      if (wd.movement_type === "lp_remove" || wd.movement_type === "bridge_out") { whaleScore -= 2; risks.push("Whale LP exit / bridge outflow"); }
      contributing.push(wm.id);
    }
    dims.push({ name: "whale_sentiment", score: whaleScore, reason: `${whalePatterns.length} patterns, ${whaleMovements.length} movements` });

    // Total score
    const totalScore = dims.reduce((s, d) => s + d.score, 0);
    const confirmingDims = dims.filter((d) => Math.sign(d.score) === Math.sign(totalScore) && d.score !== 0).length;

    // Build rationale from dims
    for (const d of dims.sort((a, b) => Math.abs(b.score) - Math.abs(a.score))) {
      if (d.score !== 0) rationale.push(`${d.name}: ${d.score > 0 ? "+" : ""}${d.score} (${d.reason})`);
    }

    // Determine class, direction, conviction
    let direction: "long" | "short" | "neutral" = "neutral";
    let conviction: "A" | "B" | "C" = "C";
    let signalClass: SignalClass = "HOLD";

    if (totalScore > 0) direction = "long";
    else if (totalScore < 0) direction = "short";

    const absScore = Math.abs(totalScore);
    if (absScore >= 6 && confirmingDims >= 3) conviction = "A";
    else if (absScore >= 3 && confirmingDims >= 2) conviction = "B";
    else if (absScore >= 1) conviction = "C";
    else { conviction = "C"; signalClass = "HOLD"; direction = "neutral"; }

    if (direction !== "neutral") {
      if (epochScore !== 0 && Math.abs(epochScore) >= 2) signalClass = "EPOCH_PLAY";
      else if (flowScore >= 2) signalClass = "ACCUMULATION";
      else if (flowScore <= -2) signalClass = "DISTRIBUTION";
      else if (anomalyScore !== 0 && Math.abs(anomalyScore) >= 2) signalClass = "MEAN_REVERSION";
      else if (direction === "long") signalClass = "MOMENTUM_LONG";
      else signalClass = "MOMENTUM_SHORT";
    }

    const signal = this.buildSignal(signalClass, direction, conviction, snapshot, rationale, contributing, risks, avgPrice);

    // Log composition
    this.logComposition(dims, totalScore, confirmingDims, signal);

    return signal;
  }

  private buildSignal(
    signalClass: SignalClass,
    direction: "long" | "short" | "neutral" | "exit",
    conviction: "A" | "B" | "C",
    snapshot: CrossChainSnapshot,
    rationale: string[],
    contributing: string[],
    risks: string[],
    entryPrice: number,
    overrideSize?: number
  ): TradingSignal {
    const now = new Date();
    const horizon = CLASS_HORIZON[signalClass] || "4h";
    const hydrexVenue = snapshot.venues.find((v) => v.venue === "hydrex_base");

    // Expiry
    let expiryMs: number;
    if (horizon === "epoch" && hydrexVenue) {
      expiryMs = 24 * 60 * 60 * 1000; // default 24h for epoch
    } else {
      expiryMs = HORIZON_MS[horizon] || 4 * 60 * 60 * 1000;
    }

    // Size model
    const baseSize = Math.min(snapshot.total_liquidity_usd * 0.01, this.maxSize);
    let size: number;
    if (overrideSize !== undefined) size = Math.min(overrideSize, baseSize);
    else if (conviction === "A") size = baseSize;
    else if (conviction === "B") size = baseSize * 0.5;
    else size = baseSize * 0.25;
    size = Math.min(size, this.maxSize);

    // Target / stop
    const score = rationale.length; // proxy for magnitude
    let target: number | null = null;
    let stop: number | null = null;
    if (direction === "long" && entryPrice > 0) {
      const movePct = Math.min(score * 0.01, 0.20);
      target = Math.round(entryPrice * (1 + movePct) * 10000) / 10000;
      stop = signalClass === "ARBITRAGE_LONG"
        ? Math.round(entryPrice * 0.98 * 10000) / 10000
        : Math.round(entryPrice * 0.93 * 10000) / 10000;
    } else if (direction === "short" && entryPrice > 0) {
      const movePct = Math.min(score * 0.01, 0.20);
      target = Math.round(entryPrice * (1 - movePct) * 10000) / 10000;
      stop = Math.round(entryPrice * 1.07 * 10000) / 10000;
    }

    const bestVenue = snapshot.venues.reduce((a, b) => a.price_usd > b.price_usd ? a : b, snapshot.venues[0]);
    const worstVenue = snapshot.venues.reduce((a, b) => a.price_usd < b.price_usd ? a : b, snapshot.venues[0]);

    const venueCtx: VenueContext = {
      best_price_venue: bestVenue?.venue || "none",
      worst_price_venue: worstVenue?.venue || "none",
      cross_chain_spread_pct: snapshot.spread_pct,
      hydrex_apr: 0,
      hydrex_hours_to_epoch: 168,
      hydrex_vote_trend: "stable",
      bridge_flow_signal: snapshot.bridge_flow.signal,
      total_liquidity_usd: snapshot.total_liquidity_usd,
    };

    const signal: TradingSignal = {
      id: crypto.randomUUID(),
      version: "1.0",
      generated_at: now.toISOString(),
      signal_class: signalClass,
      direction,
      conviction,
      token: "REGEN",
      entry_venue: direction === "long" ? (worstVenue?.venue || "best") : (bestVenue?.venue || "best"),
      entry_price_usd: entryPrice,
      target_price_usd: target,
      stop_loss_usd: stop,
      recommended_size_usd: Math.round(size),
      max_size_usd: this.maxSize,
      time_horizon: horizon as any,
      expiry_at: new Date(now.getTime() + expiryMs).toISOString(),
      rationale,
      contributing_signals: contributing,
      risk_factors: risks.length > 0 ? risks : ["Standard market risk"],
      venue_context: venueCtx,
      invalidated: false,
    };

    // Validate
    const result = TradingSignalSchema.safeParse(signal);
    if (!result.success) {
      this.logger.warn({ error: result.error.message }, "TradingSignal validation failed — returning as-is");
    }

    return signal;
  }

  private buildHold(snapshot: CrossChainSnapshot, risks: string[]): TradingSignal {
    return this.buildSignal("HOLD", "neutral", "C", snapshot, ["No clear signal — hold"], [], risks, snapshot.weighted_price_usd);
  }

  private logComposition(dims: ScoreDimension[], total: number, confirming: number, signal: TradingSignal): void {
    try {
      const entry = { timestamp: new Date().toISOString(), dims, total_score: total, confirming_dims: confirming, signal_class: signal.signal_class, conviction: signal.conviction, direction: signal.direction };
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {}
  }
}
