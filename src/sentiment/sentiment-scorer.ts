import fs from "node:fs";
import path from "node:path";
import type { ForumPost } from "./sources/regen-forum-source.js";
import type { Tweet } from "./sources/twitter-source.js";
import type { GovernanceEvent } from "./sources/governance-source.js";
import type { Logger } from "../logger.js";

export interface SentimentReport {
  overall_sentiment: "very_bullish" | "bullish" | "neutral" | "bearish" | "very_bearish";
  sentiment_score: number; // -10 to +10
  confidence: number; // 0-1
  dominant_topics: string[];
  notable_posts: { title: string; url: string; importance: string; sentiment_hint: string }[];
  governance_active: boolean;
  governance_summary: string | null;
  last_updated: string;
  sources_active: { forum: boolean; twitter: boolean; governance: boolean };
}

export class SentimentScorer {
  private logger: Logger;
  private dataDir: string;
  private cache: SentimentReport | null = null;
  private cacheTtl: number;

  constructor(dataDir: string, logger: Logger) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.cacheTtl = parseInt(process.env.SENTIMENT_CACHE_TTL_MS || "1800000", 10);
  }

  score(posts: ForumPost[], tweets: Tweet[], govEvents: GovernanceEvent[]): SentimentReport {
    let rawScore = 0;
    let sourcesContributing = 0;
    const keywords: Record<string, number> = {};

    // Forum scoring
    if (posts.length > 0) {
      sourcesContributing++;
      for (const p of posts) {
        const mult = p.importance === "HIGH" ? 2 : p.importance === "MEDIUM" ? 1 : 0.5;
        if (p.sentiment_hint === "bullish") rawScore += mult;
        else if (p.sentiment_hint === "bearish") rawScore -= mult;
        for (const k of p.keywords_found) keywords[k] = (keywords[k] || 0) + 1;
      }
    }

    // Twitter scoring
    if (tweets.length > 0) {
      sourcesContributing++;
      for (const t of tweets) {
        const mult = t.influence_score > 5 ? 1.5 : 0.5;
        if (t.sentiment_hint === "bullish") rawScore += mult;
        else if (t.sentiment_hint === "bearish") rawScore -= mult;
      }
    }

    // Governance scoring
    if (govEvents.length > 0) {
      sourcesContributing++;
      for (const g of govEvents) {
        if (g.status.includes("VOTING")) rawScore += 1; // activity = engagement
        if (g.status.includes("PASSED") && g.importance === "HIGH") rawScore += 3;
        if (g.status.includes("REJECTED") || g.status.includes("FAILED")) rawScore -= 1;
      }
    }

    // Normalize to -10/+10
    const maxPossible = Math.max(Math.abs(rawScore), 1);
    const normalized = Math.max(-10, Math.min(10, (rawScore / maxPossible) * 10));
    const score = Math.round(normalized * 10) / 10;

    const confidence = sourcesContributing < 3 ? 0 : Math.min(1, (posts.length + tweets.length + govEvents.length) / 20);

    const sortedKeywords = Object.entries(keywords).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);

    let sentiment: SentimentReport["overall_sentiment"];
    if (score > 6) sentiment = "very_bullish";
    else if (score > 3) sentiment = "bullish";
    else if (score < -6) sentiment = "very_bearish";
    else if (score < -3) sentiment = "bearish";
    else sentiment = "neutral";

    const votingProposals = govEvents.filter(g => g.status.includes("VOTING"));

    const report: SentimentReport = {
      overall_sentiment: sentiment,
      sentiment_score: score,
      confidence,
      dominant_topics: sortedKeywords,
      notable_posts: posts.filter(p => p.importance === "HIGH").slice(0, 5).map(p => ({ title: p.title, url: p.url, importance: p.importance, sentiment_hint: p.sentiment_hint })),
      governance_active: votingProposals.length > 0,
      governance_summary: votingProposals.length > 0 ? `${votingProposals.length} proposal(s) in voting: ${votingProposals.map(p => p.title).join(", ")}` : null,
      last_updated: new Date().toISOString(),
      sources_active: { forum: posts.length > 0, twitter: tweets.length > 0, governance: govEvents.length > 0 },
    };

    this.cache = report;
    this.persistHistory(report);
    return report;
  }

  getCached(): SentimentReport | null { return this.cache; }

  private persistHistory(report: SentimentReport): void {
    try {
      const histPath = path.join(this.dataDir, "sentiment-history.jsonl");
      const dir = path.dirname(histPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(histPath, JSON.stringify({ timestamp: report.last_updated, score: report.sentiment_score, sentiment: report.overall_sentiment }) + "\n", "utf-8");
    } catch {}
  }
}
