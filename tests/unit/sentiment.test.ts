import { describe, it, expect } from "vitest";
import { SentimentScorer } from "../../src/sentiment/sentiment-scorer.js";
import { TwitterSource } from "../../src/sentiment/sources/twitter-source.js";
import type { ForumPost } from "../../src/sentiment/sources/regen-forum-source.js";
import type { GovernanceEvent } from "../../src/sentiment/sources/governance-source.js";
import type { Tweet } from "../../src/sentiment/sources/twitter-source.js";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makePost(overrides: Partial<ForumPost> = {}): ForumPost {
  return {
    id: "1", title: "Test Post", url: "https://forum.regen.network", author: "test",
    category: "General", importance: "HIGH", sentiment_hint: "neutral",
    created_at: new Date().toISOString(), keywords_found: [],
    ...overrides,
  };
}

function makeTweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: "t1", text: "Test tweet", author_username: "test", author_followers: 5000,
    created_at: new Date().toISOString(), retweets: 10, likes: 50,
    sentiment_hint: "neutral", influence_score: 4.0,
    ...overrides,
  };
}

function makeGov(overrides: Partial<GovernanceEvent> = {}): GovernanceEvent {
  return {
    proposal_id: "1", title: "Test Proposal", status: "PROPOSAL_STATUS_VOTING_PERIOD",
    voting_end_time: new Date(Date.now() + 86400000).toISOString(),
    yes_pct: 70, no_pct: 20, abstain_pct: 10, description_excerpt: "Test",
    importance: "HIGH",
    ...overrides,
  };
}

describe("SentimentScorer", () => {
  let tmpDir: string;

  beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(tmpdir(), "sent-")); });
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("HIGH importance + BULLISH keywords adds +2", () => {
    const scorer = new SentimentScorer(tmpDir, mockLogger());
    const posts = [makePost({ importance: "HIGH", sentiment_hint: "bullish" })];
    const report = scorer.score(posts, [], []);
    expect(report.sentiment_score).toBeGreaterThan(0);
  });

  it("BEARISH keywords in multiple HIGH posts drives score negative", () => {
    const scorer = new SentimentScorer(tmpDir, mockLogger());
    const posts = [
      makePost({ importance: "HIGH", sentiment_hint: "bearish" }),
      makePost({ id: "2", importance: "HIGH", sentiment_hint: "bearish" }),
      makePost({ id: "3", importance: "HIGH", sentiment_hint: "bearish" }),
    ];
    const report = scorer.score(posts, [], []);
    expect(report.sentiment_score).toBeLessThan(0);
  });

  it("confidence = 0 when fewer than 3 sources contributed", () => {
    const scorer = new SentimentScorer(tmpDir, mockLogger());
    const report = scorer.score([makePost()], [], []);
    expect(report.confidence).toBe(0);
  });

  it("score normalized to -10/+10 range", () => {
    const scorer = new SentimentScorer(tmpDir, mockLogger());
    const posts = Array.from({ length: 20 }, (_, i) => makePost({ id: String(i), importance: "HIGH", sentiment_hint: "bullish" }));
    const report = scorer.score(posts, [], []);
    expect(report.sentiment_score).toBeLessThanOrEqual(10);
    expect(report.sentiment_score).toBeGreaterThanOrEqual(-10);
  });

  it("governance proposal in voting flagged as active", () => {
    const scorer = new SentimentScorer(tmpDir, mockLogger());
    const report = scorer.score([], [], [makeGov()]);
    expect(report.governance_active).toBe(true);
    expect(report.governance_summary).toContain("proposal");
  });
});

describe("TwitterSource", () => {
  it("skips gracefully when TWITTER_BEARER_TOKEN not set", async () => {
    delete process.env.TWITTER_BEARER_TOKEN;
    const source = new TwitterSource(mockLogger());
    expect(source.isConfigured).toBe(false);
    const tweets = await source.poll();
    expect(tweets).toEqual([]);
  });
});

import { beforeAll, afterAll } from "vitest";
