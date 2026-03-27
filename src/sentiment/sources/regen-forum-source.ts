import type { Logger } from "../../logger.js";

export interface ForumPost {
  id: string;
  title: string;
  url: string;
  author: string;
  category: string;
  importance: "HIGH" | "MEDIUM" | "LOW";
  sentiment_hint: "bullish" | "bearish" | "neutral";
  created_at: string;
  keywords_found: string[];
}

const BULLISH = ["listing", "partnership", "grant", "milestone", "launch", "adoption", "integration", "upgrade"];
const BEARISH = ["delay", "issue", "concern", "vulnerability", "hack", "exploit", "shutdown", "pause"];
const HIGH_CATS = ["general", "governance", "announcements", "partnerships"];
const MED_CATS = ["development", "community"];

export class RegenForumSource {
  private feedUrl: string;
  private logger: Logger;
  private cache: ForumPost[] = [];

  constructor(logger: Logger) {
    this.feedUrl = process.env.REGEN_FORUM_RSS || "https://forum.regen.network/latest.rss";
    this.logger = logger;
  }

  async poll(): Promise<ForumPost[]> {
    try {
      const res = await fetch(this.feedUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return this.cache;
      const xml = await res.text();
      const posts = this.parseRSS(xml);
      this.cache = posts.slice(0, 100);
      return this.cache;
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Forum RSS fetch failed");
      return this.cache;
    }
  }

  getCached(): ForumPost[] { return this.cache; }

  private parseRSS(xml: string): ForumPost[] {
    const posts: ForumPost[] = [];
    const items = xml.split("<item>").slice(1);
    for (const item of items) {
      const title = this.extractTag(item, "title");
      const link = this.extractTag(item, "link");
      const author = this.extractTag(item, "dc:creator") || this.extractTag(item, "author") || "";
      const category = this.extractTag(item, "category") || "";
      const pubDate = this.extractTag(item, "pubDate") || "";
      const desc = this.extractTag(item, "description")?.slice(0, 500) || "";
      const text = (title + " " + desc).toLowerCase();

      const foundBullish = BULLISH.filter(k => text.includes(k));
      const foundBearish = BEARISH.filter(k => text.includes(k));
      const sentiment = foundBullish.length > foundBearish.length ? "bullish" : foundBearish.length > 0 ? "bearish" : "neutral";
      const catLower = category.toLowerCase();
      const importance = HIGH_CATS.some(c => catLower.includes(c)) ? "HIGH" : MED_CATS.some(c => catLower.includes(c)) ? "MEDIUM" : "LOW";

      posts.push({
        id: link || crypto.randomUUID(),
        title, url: link, author, category, importance, sentiment_hint: sentiment,
        created_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        keywords_found: [...foundBullish, ...foundBearish],
      });
    }
    return posts;
  }

  private extractTag(xml: string, tag: string): string {
    const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`));
    return (match?.[1] || match?.[2] || "").trim();
  }
}
