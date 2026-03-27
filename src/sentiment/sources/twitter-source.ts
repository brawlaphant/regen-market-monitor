import type { Logger } from "../../logger.js";

export interface Tweet {
  id: string;
  text: string;
  author_username: string;
  author_followers: number;
  created_at: string;
  retweets: number;
  likes: number;
  sentiment_hint: "bullish" | "bearish" | "neutral";
  influence_score: number;
}

const BULLISH = ["listing", "partnership", "grant", "milestone", "launch", "adoption", "integration", "upgrade"];
const BEARISH = ["delay", "issue", "concern", "vulnerability", "hack", "exploit", "shutdown", "pause"];

export class TwitterSource {
  private token: string | undefined;
  private minFollowers: number;
  private logger: Logger;
  private cache: Tweet[] = [];

  constructor(logger: Logger) {
    this.token = process.env.TWITTER_BEARER_TOKEN || undefined;
    this.minFollowers = parseInt(process.env.TWITTER_MIN_FOLLOWERS || "100", 10);
    this.logger = logger;
    if (!this.token) this.logger.info("Twitter integration disabled — TWITTER_BEARER_TOKEN not set");
  }

  get isConfigured(): boolean { return !!this.token; }

  async poll(): Promise<Tweet[]> {
    if (!this.token) return [];
    try {
      const query = encodeURIComponent("REGEN token OR regen.network OR @regen_network -is:retweet lang:en");
      const res = await fetch(
        `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=created_at,public_metrics&expansions=author_id&user.fields=public_metrics,username`,
        { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) { this.logger.warn({ status: res.status }, "Twitter API error"); return this.cache; }
      const data = (await res.json()) as any;
      const users = new Map((data?.includes?.users || []).map((u: any) => [u.id, u]));
      const tweets: Tweet[] = [];
      for (const t of data?.data || []) {
        const author = users.get(t.author_id) as any;
        const followers = author?.public_metrics?.followers_count || 0;
        if (followers < this.minFollowers) continue;
        const text = (t.text || "").toLowerCase();
        const bullish = BULLISH.filter(k => text.includes(k));
        const bearish = BEARISH.filter(k => text.includes(k));
        const sentiment = bullish.length > bearish.length ? "bullish" : bearish.length > 0 ? "bearish" : "neutral";
        const influence = Math.log10(Math.max(followers, 1)) * (1 + (t.public_metrics?.retweet_count || 0) * 0.1);
        tweets.push({
          id: t.id, text: t.text, author_username: author?.username || "",
          author_followers: followers, created_at: t.created_at || "",
          retweets: t.public_metrics?.retweet_count || 0, likes: t.public_metrics?.like_count || 0,
          sentiment_hint: sentiment, influence_score: Math.round(influence * 10) / 10,
        });
      }
      this.cache = tweets;
      return tweets;
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Twitter poll failed");
      return this.cache;
    }
  }

  getCached(): Tweet[] { return this.cache; }
}
