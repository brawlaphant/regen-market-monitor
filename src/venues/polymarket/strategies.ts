/**
 * Polymarket Signal Strategies
 *
 * Four strategies that scan markets and produce scored signals:
 * - Spray: broad divergence scan across all markets
 * - Worldview: category-filtered with context enrichment
 * - Contrarian: fade overconfident crowds (>85%)
 * - Closer: high-conviction in final 48hrs before resolution
 *
 * All scoring goes through LITCREDIT relay — every call burns LC on-chain.
 */

import type { LitcreditScorer } from "../../scoring/litcredit-provider.js";
import type { PolymarketClient } from "./client.js";
import type { PolymarketMarket, ScoredMarket } from "./types.js";
import { categorizeMarket } from "./types.js";
import { kellySize, signalToKellyInput, isDeadPolymarket } from "../../execution/trading-risk.js";

// ── Thresholds ─────────────────────────────────────────────────────

const SPRAY_THRESHOLD = 0.15;
const WORLDVIEW_THRESHOLD = 0.20;
const CONTRARIAN_CONFIDENCE = 0.85;
const CLOSER_THRESHOLD = 0.25;
const CLOSER_HOURS = 48;
const CLOSER_MIN_LIQ = 100_000;

// ── Sizing ─────────────────────────────────────────────────────────

/**
 * Kelly-informed bet sizing for prediction markets.
 * Divergence = edge. Clamped to [minBet, maxBet].
 */
export function computeBetSize(
  divergence: number,
  threshold: number,
  minBet: number,
  maxBet: number
): number {
  const absDiv = Math.abs(divergence);
  if (absDiv < threshold) return minBet;

  const ki = signalToKellyInput("spray", { divergence });
  const dailyBankroll = 50; // regen-market-monitor default
  const kellySized = kellySize({ edge: ki.edge, confidence: ki.confidence, bankroll: dailyBankroll, maxPct: 0.30 });
  return Math.round(Math.min(maxBet, Math.max(minBet, kellySized)) * 100) / 100;
}

/** Filter dead markets (price <10% or >90%) */
export function filterDead(markets: Array<{ tokens?: Array<{ price?: number }> }>): typeof markets {
  return markets.filter(m => {
    const price = m.tokens?.[0]?.price ?? 0.5;
    return !isDeadPolymarket(price);
  });
}

// ── Strategies ─────────────────────────────────────────────────────

/** Broad divergence scan — score all markets, flag divergences >= 15% */
export async function runSpray(
  markets: PolymarketMarket[],
  client: PolymarketClient,
  scorer: LitcreditScorer
): Promise<ScoredMarket[]> {
  const signals: ScoredMarket[] = [];
  for (const market of markets) {
    const crowdYes = client.parseCrowdPrice(market);
    if (crowdYes === null) continue;

    const aiYes = await scorer.scoreProbability(market.question, crowdYes);
    if (aiYes === null) continue;

    const divergence = aiYes - crowdYes;
    if (Math.abs(divergence) < SPRAY_THRESHOLD) continue;

    signals.push({
      question: market.question,
      slug: market.conditionId || market.id,
      crowdYes,
      aiYes,
      divergence,
      direction: divergence > 0 ? "BUY_YES" : "BUY_NO",
      betSize: computeBetSize(divergence, SPRAY_THRESHOLD, 2, 8),
      liquidity: parseFloat(market.liquidity || "0"),
      category: categorizeMarket(market.question) || undefined,
      source: "spray",
    });
  }
  return signals;
}

/** Category-filtered markets with context enrichment */
export async function runWorldview(
  markets: PolymarketMarket[],
  client: PolymarketClient,
  scorer: LitcreditScorer
): Promise<ScoredMarket[]> {
  const signals: ScoredMarket[] = [];
  const filtered = markets.filter((m) => categorizeMarket(m.question) !== null);

  for (const market of filtered.slice(0, 20)) {
    const crowdYes = client.parseCrowdPrice(market);
    if (crowdYes === null) continue;

    const headlines = await scorer.generateContext(market.question);
    const aiYes = await scorer.scoreProbabilityWithContext(
      market.question,
      crowdYes,
      headlines || ""
    );
    if (aiYes === null) continue;

    const divergence = aiYes - crowdYes;
    if (Math.abs(divergence) < WORLDVIEW_THRESHOLD) continue;

    signals.push({
      question: market.question,
      slug: market.conditionId || market.id,
      crowdYes,
      aiYes,
      divergence,
      direction: divergence > 0 ? "BUY_YES" : "BUY_NO",
      betSize: computeBetSize(divergence, WORLDVIEW_THRESHOLD, 3, 10),
      liquidity: parseFloat(market.liquidity || "0"),
      category: categorizeMarket(market.question) || undefined,
      source: "worldview",
    });
  }
  return signals;
}

/** Fade overconfident crowds — markets where crowd > 85% and AI disagrees */
export async function runContrarian(
  markets: PolymarketMarket[],
  client: PolymarketClient,
  scorer: LitcreditScorer
): Promise<ScoredMarket[]> {
  const signals: ScoredMarket[] = [];

  const extreme = markets.filter((m) => {
    const price = client.parseCrowdPrice(m);
    return price !== null && (price > CONTRARIAN_CONFIDENCE || price < 1 - CONTRARIAN_CONFIDENCE);
  });

  for (const market of extreme.slice(0, 15)) {
    const crowdYes = client.parseCrowdPrice(market)!;
    const aiYes = await scorer.scoreProbability(market.question, crowdYes);
    if (aiYes === null) continue;

    const crowdSide = crowdYes > 0.5 ? "yes" : "no";
    const crowdConfidence = crowdSide === "yes" ? crowdYes : 1 - crowdYes;
    const aiConfidence = crowdSide === "yes" ? aiYes : 1 - aiYes;

    // AI must be meaningfully less confident than crowd
    if (aiConfidence >= crowdConfidence - 0.10) continue;

    const divergence = aiYes - crowdYes;
    signals.push({
      question: market.question,
      slug: market.conditionId || market.id,
      crowdYes,
      aiYes,
      divergence,
      direction: crowdSide === "yes" ? "BUY_NO" : "BUY_YES",
      betSize: computeBetSize(divergence, 0.10, 3, 8),
      liquidity: parseFloat(market.liquidity || "0"),
      category: categorizeMarket(market.question) || undefined,
      source: "contrarian",
    });
  }
  return signals;
}

/** Final 48hrs, high conviction — markets near resolution with large divergence */
export async function runCloser(
  markets: PolymarketMarket[],
  client: PolymarketClient,
  scorer: LitcreditScorer
): Promise<ScoredMarket[]> {
  const signals: ScoredMarket[] = [];

  const closing = markets.filter((m) => {
    if (!m.endDate) return false;
    const end = Date.parse(m.endDate);
    if (isNaN(end)) return false;
    const hoursLeft = (end - Date.now()) / (1000 * 60 * 60);
    const liq = parseFloat(m.liquidity || "0");
    return hoursLeft > 0 && hoursLeft <= CLOSER_HOURS && liq >= CLOSER_MIN_LIQ;
  });

  for (const market of closing) {
    const crowdYes = client.parseCrowdPrice(market);
    if (crowdYes === null) continue;

    const context = await scorer.generateContext(market.question);
    const aiYes = await scorer.scoreProbabilityWithContext(
      market.question,
      crowdYes,
      `This market resolves within 48 hours.\n${context || ""}`
    );
    if (aiYes === null) continue;

    const divergence = aiYes - crowdYes;
    if (Math.abs(divergence) < CLOSER_THRESHOLD) continue;

    signals.push({
      question: market.question,
      slug: market.conditionId || market.id,
      crowdYes,
      aiYes,
      divergence,
      direction: divergence > 0 ? "BUY_YES" : "BUY_NO",
      betSize: computeBetSize(divergence, CLOSER_THRESHOLD, 5, 15),
      liquidity: parseFloat(market.liquidity || "0"),
      category: categorizeMarket(market.question) || undefined,
      source: "closer",
    });
  }
  return signals;
}

/** Deduplicate and rank signals by absolute edge strength */
export function dedupeAndRank(signals: ScoredMarket[]): ScoredMarket[] {
  const bySlug = new Map<string, ScoredMarket>();
  for (const s of signals) {
    const existing = bySlug.get(s.slug);
    if (!existing || Math.abs(s.divergence) > Math.abs(existing.divergence)) {
      bySlug.set(s.slug, s);
    }
  }
  return Array.from(bySlug.values()).sort(
    (a, b) => Math.abs(b.divergence) - Math.abs(a.divergence)
  );
}
