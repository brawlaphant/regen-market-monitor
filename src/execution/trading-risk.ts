/**
 * Trading Risk Module — Kelly Sizer, Correlation Tracker, Exchange Guards
 *
 * Ported from MVP/scripts/trading-risk.ts.
 * Kept in sync — same API, same logic.
 */

// ── Asset Correlation Groups ───────────────────────────────────────────────

export const CORRELATION_GROUPS: Record<string, string[]> = {
  btc_ecosystem: ["BTC", "WBTC", "cbBTC"],
  eth_ecosystem: ["ETH", "WETH", "stETH", "cbETH", "rETH"],
  sol_ecosystem: ["SOL", "JTO", "JUP", "BONK", "WIF", "PYTH"],
  l1_alts:       ["AVAX", "SUI", "APT", "SEI", "TIA", "INJ", "NEAR"],
  meme:          ["DOGE", "SHIB", "PEPE", "FLOKI", "MEME"],
  defi:          ["AAVE", "UNI", "MKR", "CRV", "LINK", "SNX"],
  ai_tokens:     ["FET", "RENDER", "TAO", "RNDR", "AKT"],
  regen:         ["REGEN", "NCT", "TOUCAN"],
};

// ── Kelly Sizer ────────────────────────────────────────────────────────────

export interface KellyInput {
  edge: number;
  confidence: number;
  bankroll: number;
  maxPct?: number;
  minSize?: number;
}

export function kellySize(input: KellyInput): number {
  const { edge, confidence, bankroll, maxPct = 0.05, minSize = 1.0 } = input;
  if (bankroll <= 0 || confidence <= 0 || edge <= 0) return minSize;
  const kellyFraction = Math.abs(edge) * (confidence / 100) / 2;
  const capped = Math.min(kellyFraction, maxPct);
  const size = capped * bankroll;
  return Math.max(minSize, Math.round(size * 100) / 100);
}

export function signalToKellyInput(
  strategy: string,
  rawValues: {
    fundingAnnualized?: number;
    momentumPct?: number;
    oiImbalancePct?: number;
    divergence?: number;
  },
): { edge: number; confidence: number } {
  switch (strategy) {
    case "funding": {
      const rate = Math.abs(rawValues.fundingAnnualized ?? 0);
      const confidence = Math.min(90, rate * 100 * 15);
      return { edge: Math.min(rate, 0.20), confidence: Math.max(10, confidence) };
    }
    case "momentum": {
      const change = Math.abs(rawValues.momentumPct ?? 0);
      const confidence = Math.min(85, change * 100 * 10);
      return { edge: Math.min(change, 0.15), confidence: Math.max(15, confidence) };
    }
    case "oi_imbalance":
    case "mean_reversion": {
      const imbalance = Math.abs((rawValues.oiImbalancePct ?? 0.5) - 0.5);
      const confidence = Math.min(70, imbalance * 100 * 3);
      return { edge: Math.min(imbalance, 0.15), confidence: Math.max(10, confidence) };
    }
    case "spray":
    case "worldview":
    case "contrarian":
    case "closer": {
      const div = Math.abs(rawValues.divergence ?? 0);
      const confidence = Math.min(85, div * 100 * 2);
      return { edge: Math.min(div, 0.40), confidence: Math.max(20, confidence) };
    }
    default:
      return { edge: 0.02, confidence: 30 };
  }
}

// ── Correlation Tracker ────────────────────────────────────────────────────

interface GroupExposure { long: number; short: number; }

export class CorrelationTracker {
  private symbolToGroup: Map<string, string>;
  private exposure: Map<string, GroupExposure> = new Map();
  private maxGroupPct: number;
  private maxDirectionalPct: number;

  constructor(config: { groups?: Record<string, string[]>; maxGroupPct?: number; maxDirectionalPct?: number } = {}) {
    const groups = config.groups ?? CORRELATION_GROUPS;
    this.maxGroupPct = config.maxGroupPct ?? 0.15;
    this.maxDirectionalPct = config.maxDirectionalPct ?? 0.40;
    this.symbolToGroup = new Map();
    for (const [group, symbols] of Object.entries(groups)) {
      for (const sym of symbols) this.symbolToGroup.set(sym.toUpperCase(), group);
    }
  }

  getGroup(symbol: string): string {
    return this.symbolToGroup.get(symbol.toUpperCase()) ?? `solo_${symbol.toUpperCase()}`;
  }

  addExposure(symbol: string, sizeUsd: number, direction: "long" | "short"): void {
    const group = this.getGroup(symbol);
    const existing = this.exposure.get(group) ?? { long: 0, short: 0 };
    existing[direction] += Math.abs(sizeUsd);
    this.exposure.set(group, existing);
  }

  reset(): void { this.exposure.clear(); }

  check(symbol: string, sizeUsd: number, direction: "long" | "short", bankroll: number): string | null {
    if (bankroll <= 0) return null;
    const group = this.getGroup(symbol);
    const existing = this.exposure.get(group) ?? { long: 0, short: 0 };
    const newExposure = existing[direction] + Math.abs(sizeUsd);
    const groupLimit = bankroll * this.maxGroupPct;
    if (newExposure > groupLimit) {
      return `correlated_exposure: ${group} $${newExposure.toFixed(2)} > $${groupLimit.toFixed(2)}`;
    }
    let totalLong = 0, totalShort = 0;
    for (const [, exp] of this.exposure) { totalLong += exp.long; totalShort += exp.short; }
    if (direction === "long") totalLong += Math.abs(sizeUsd); else totalShort += Math.abs(sizeUsd);
    const dirLimit = bankroll * this.maxDirectionalPct;
    if (totalLong > dirLimit) return `directional_exposure: total long $${totalLong.toFixed(2)} > $${dirLimit.toFixed(2)}`;
    if (totalShort > dirLimit) return `directional_exposure: total short $${totalShort.toFixed(2)} > $${dirLimit.toFixed(2)}`;
    return null;
  }

  recordTrade(symbol: string, sizeUsd: number, direction: "long" | "short"): void {
    this.addExposure(symbol, sizeUsd, direction);
  }
}

// ── Exchange Guards ────────────────────────────────────────────────────────

export function isDeadPolymarket(yesPrice: number): boolean {
  return yesPrice < 0.10 || yesPrice > 0.90;
}

export function isNegRiskPhantom(bestBid: number, bestAsk: number): boolean {
  return (bestBid <= 0.01 && bestAsk >= 0.99);
}
