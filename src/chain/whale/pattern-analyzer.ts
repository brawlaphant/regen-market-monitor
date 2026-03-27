import type { WalletMovement } from "./movement-detector.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PatternType =
  | "ACCUMULATION_CLUSTER"
  | "DISTRIBUTION_CLUSTER"
  | "BRIDGE_EXODUS"
  | "EXCHANGE_DEPOSIT"
  | "LP_EXIT"
  | "LP_ENTRY"
  | "STEALTH_ACCUMULATION"
  | "DORMANT_AWAKENING";

export type DominantSignal = "bullish" | "bearish" | "neutral";

export interface DetectedPattern {
  type: PatternType;
  signal: "bullish" | "bearish";
  affected_wallets: string[];
  detail: string;
}

export interface PatternReport {
  patterns_detected: DetectedPattern[];
  dominant_signal: DominantSignal;
  confidence: number; // 0–1
  affected_wallets: string[];
  summary: string;
  recommended_action: string;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const CRITICAL_THRESHOLD = parseFloat(process.env.WHALE_CRITICAL_THRESHOLD_REGEN || "500000");
const HIGH_THRESHOLD = parseFloat(process.env.WHALE_HIGH_THRESHOLD_REGEN || "100000");
const CLUSTER_MIN_WALLETS = 3;
const STEALTH_MIN_RECEIVES = 5;
const DORMANT_DAYS = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uniqueWallets(movements: WalletMovement[]): string[] {
  return Array.from(new Set(movements.map((m) => m.wallet_address)));
}

function hoursAgo(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / (1000 * 60 * 60);
}

function daysAgo(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

// ─── PatternAnalyzer ──────────────────────────────────────────────────────────

export class PatternAnalyzer {
  /**
   * Analyze a set of movements within a given time window.
   * @param movements - recent wallet movements
   * @param windowHours - how far back to look (default 24h)
   * @param walletLastSeen - optional map of address → last_seen_active ISO string
   *                          (pass from WalletRegistry to detect dormant awakenings)
   */
  analyze(
    movements: WalletMovement[],
    windowHours: number = 24,
    walletLastSeen?: Map<string, string>
  ): PatternReport {
    const now = Date.now();
    const cutoff = now - windowHours * 60 * 60 * 1000;

    // Filter to window
    const windowed = movements.filter((m) => new Date(m.timestamp).getTime() >= cutoff);

    if (windowed.length === 0) {
      return {
        patterns_detected: [],
        dominant_signal: "neutral",
        confidence: 0,
        affected_wallets: [],
        summary: "No whale movements in analysis window.",
        recommended_action: "Continue monitoring.",
      };
    }

    const patterns: DetectedPattern[] = [];

    // ── ACCUMULATION_CLUSTER: 3+ wallets receiving in window ──────────
    const receives = windowed.filter((m) => m.movement_type === "receive");
    const receiveWallets = uniqueWallets(receives);
    if (receiveWallets.length >= CLUSTER_MIN_WALLETS) {
      const totalAmount = receives.reduce((sum, m) => sum + m.amount_regen, 0);
      patterns.push({
        type: "ACCUMULATION_CLUSTER",
        signal: "bullish",
        affected_wallets: receiveWallets,
        detail: `${receiveWallets.length} wallets accumulated ${totalAmount.toLocaleString()} REGEN in ${windowHours}h`,
      });
    }

    // ── DISTRIBUTION_CLUSTER: 3+ wallets sending in window ────────────
    const sends = windowed.filter((m) => m.movement_type === "send");
    const sendWallets = uniqueWallets(sends);
    if (sendWallets.length >= CLUSTER_MIN_WALLETS) {
      const totalAmount = sends.reduce((sum, m) => sum + m.amount_regen, 0);
      patterns.push({
        type: "DISTRIBUTION_CLUSTER",
        signal: "bearish",
        affected_wallets: sendWallets,
        detail: `${sendWallets.length} wallets distributed ${totalAmount.toLocaleString()} REGEN in ${windowHours}h`,
      });
    }

    // ── BRIDGE_EXODUS: net outflow via bridge_out > critical threshold ─
    const bridgeOuts = windowed.filter((m) => m.movement_type === "bridge_out");
    const bridgeIns = windowed.filter((m) => m.movement_type === "bridge_in");
    const netBridgeOutflow =
      bridgeOuts.reduce((s, m) => s + m.amount_regen, 0) -
      bridgeIns.reduce((s, m) => s + m.amount_regen, 0);
    if (netBridgeOutflow > CRITICAL_THRESHOLD) {
      patterns.push({
        type: "BRIDGE_EXODUS",
        signal: "bearish",
        affected_wallets: uniqueWallets(bridgeOuts),
        detail: `Net bridge outflow of ${netBridgeOutflow.toLocaleString()} REGEN exceeds critical threshold`,
      });
    }

    // ── EXCHANGE_DEPOSIT: large sends that look like exchange deposits ─
    // Heuristic: large sends to unlabeled counterparties
    const largeSends = sends.filter(
      (m) => m.amount_regen >= HIGH_THRESHOLD && !m.counterparty_label
    );
    if (largeSends.length > 0) {
      patterns.push({
        type: "EXCHANGE_DEPOSIT",
        signal: "bearish",
        affected_wallets: uniqueWallets(largeSends),
        detail: `${largeSends.length} large sends (${largeSends.reduce((s, m) => s + m.amount_regen, 0).toLocaleString()} REGEN) to unknown addresses — possible exchange deposits`,
      });
    }

    // ── LP_EXIT: large lp_remove movements ────────────────────────────
    const lpRemoves = windowed.filter(
      (m) => m.movement_type === "lp_remove" && m.amount_regen >= HIGH_THRESHOLD
    );
    if (lpRemoves.length > 0) {
      patterns.push({
        type: "LP_EXIT",
        signal: "bearish",
        affected_wallets: uniqueWallets(lpRemoves),
        detail: `${lpRemoves.length} LP removals totaling ${lpRemoves.reduce((s, m) => s + m.amount_regen, 0).toLocaleString()} REGEN`,
      });
    }

    // ── LP_ENTRY: large lp_add movements ──────────────────────────────
    const lpAdds = windowed.filter(
      (m) => m.movement_type === "lp_add" && m.amount_regen >= HIGH_THRESHOLD
    );
    if (lpAdds.length > 0) {
      patterns.push({
        type: "LP_ENTRY",
        signal: "bullish",
        affected_wallets: uniqueWallets(lpAdds),
        detail: `${lpAdds.length} LP additions totaling ${lpAdds.reduce((s, m) => s + m.amount_regen, 0).toLocaleString()} REGEN`,
      });
    }

    // ── STEALTH_ACCUMULATION: 1 wallet, many small receives ───────────
    const receivesByWallet = new Map<string, WalletMovement[]>();
    for (const m of receives) {
      const arr = receivesByWallet.get(m.wallet_address) || [];
      arr.push(m);
      receivesByWallet.set(m.wallet_address, arr);
    }
    for (const [addr, moves] of Array.from(receivesByWallet.entries())) {
      if (moves.length >= STEALTH_MIN_RECEIVES) {
        const total = moves.reduce((s, m) => s + m.amount_regen, 0);
        patterns.push({
          type: "STEALTH_ACCUMULATION",
          signal: "bullish",
          affected_wallets: [addr],
          detail: `Wallet ${moves[0].wallet_label || addr.slice(0, 12)} made ${moves.length} small receives totaling ${total.toLocaleString()} REGEN`,
        });
      }
    }

    // ── DORMANT_AWAKENING: wallet inactive > 30 days suddenly moves ───
    if (walletLastSeen) {
      for (const m of windowed) {
        const lastSeen = walletLastSeen.get(m.wallet_address);
        if (lastSeen && daysAgo(lastSeen, now) > DORMANT_DAYS) {
          patterns.push({
            type: "DORMANT_AWAKENING",
            signal: m.movement_type === "receive" ? "bullish" : "bearish",
            affected_wallets: [m.wallet_address],
            detail: `${m.wallet_label || m.wallet_address.slice(0, 12)} dormant for ${Math.floor(daysAgo(lastSeen, now))} days, now ${m.movement_type} ${m.amount_regen.toLocaleString()} REGEN`,
          });
        }
      }
    }

    // ── Dominant signal ───────────────────────────────────────────────
    let bullish = 0;
    let bearish = 0;
    for (const p of patterns) {
      if (p.signal === "bullish") bullish++;
      if (p.signal === "bearish") bearish++;
    }

    let dominantSignal: DominantSignal = "neutral";
    if (bullish > bearish) dominantSignal = "bullish";
    else if (bearish > bullish) dominantSignal = "bearish";

    // Confidence: how decisive the signal is (0–1)
    const total = bullish + bearish;
    const confidence =
      total === 0 ? 0 : Math.abs(bullish - bearish) / total;

    // Collect all affected wallets
    const allAffected = Array.from(new Set(patterns.flatMap((p) => p.affected_wallets)));

    // Build summary
    const summary = this.buildSummary(patterns, dominantSignal, windowed.length, windowHours);
    const recommendedAction = this.buildRecommendation(dominantSignal, patterns, confidence);

    return {
      patterns_detected: patterns,
      dominant_signal: dominantSignal,
      confidence: Math.round(confidence * 100) / 100,
      affected_wallets: allAffected,
      summary,
      recommended_action: recommendedAction,
    };
  }

  // ─── Internal helpers ───────────────────────────────────────────────

  private buildSummary(
    patterns: DetectedPattern[],
    signal: DominantSignal,
    movementCount: number,
    windowHours: number
  ): string {
    if (patterns.length === 0) {
      return `${movementCount} movements in ${windowHours}h window — no significant patterns detected.`;
    }

    const patternNames = patterns.map((p) => p.type).join(", ");
    return `${movementCount} movements in ${windowHours}h window. ${patterns.length} pattern(s) detected: ${patternNames}. Dominant signal: ${signal}.`;
  }

  private buildRecommendation(
    signal: DominantSignal,
    patterns: DetectedPattern[],
    confidence: number
  ): string {
    const hasBridgeExodus = patterns.some((p) => p.type === "BRIDGE_EXODUS");
    const hasDormant = patterns.some((p) => p.type === "DORMANT_AWAKENING");
    const hasLpExit = patterns.some((p) => p.type === "LP_EXIT");

    if (hasBridgeExodus) {
      return "ALERT: Significant bridge outflow detected. Monitor for further exodus. Consider reducing exposure.";
    }

    if (hasLpExit && signal === "bearish") {
      return "LP exits combined with bearish signal — liquidity leaving. Watch for price impact.";
    }

    if (hasDormant) {
      return "Dormant whale(s) awakened — watch for follow-through moves in next 24h.";
    }

    if (signal === "bullish" && confidence > 0.6) {
      return "Strong accumulation signal. Whales are buying — consider following with caution.";
    }

    if (signal === "bearish" && confidence > 0.6) {
      return "Strong distribution signal. Whales are selling — exercise caution.";
    }

    return "Mixed signals. Continue monitoring for pattern confirmation.";
  }
}
