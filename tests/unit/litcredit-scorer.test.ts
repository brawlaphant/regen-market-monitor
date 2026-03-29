import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { RelayClient } from "../../src/litcoin/relay-client.js";
import { LitcreditScorer } from "../../src/scoring/litcredit-provider.js";
import type { RelayConfig } from "../../src/litcoin/types.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeRelay(tmpDir: string): RelayClient {
  const config: RelayConfig = {
    baseUrl: "https://api.litcoiin.xyz/v1",
    authMethod: "key",
    apiKey: "test-key",
    timeoutMs: 5000,
    retryTimeoutMs: 10000,
    model: "auto",
  };
  return new RelayClient(config, tmpDir, mockLogger());
}

describe("LitcreditScorer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "scorer-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("scores probability from relay response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "65.0" } }],
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
      }),
    }));

    const scorer = new LitcreditScorer(makeRelay(tmpDir), mockLogger());
    const prob = await scorer.scoreProbability("Will BTC hit $100K?", 0.72);
    expect(prob).toBeCloseTo(0.65, 2);
  });

  it("returns null for non-numeric response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "I think probably yes" } }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      }),
    }));

    const scorer = new LitcreditScorer(makeRelay(tmpDir), mockLogger());
    const prob = await scorer.scoreProbability("Will BTC hit $100K?", 0.72);
    expect(prob).toBeNull();
  });

  it("returns null for out-of-range response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "150" } }],
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
      }),
    }));

    const scorer = new LitcreditScorer(makeRelay(tmpDir), mockLogger());
    const prob = await scorer.scoreProbability("test", 0.5);
    expect(prob).toBeNull();
  });

  it("returns null when relay fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const scorer = new LitcreditScorer(makeRelay(tmpDir), mockLogger());
    const prob = await scorer.scoreProbability("test", 0.5);
    expect(prob).toBeNull();
  });

  it("generates context via relay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "1. News headline\n2. Another headline\n3. Third" } }],
        usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      }),
    }));

    const scorer = new LitcreditScorer(makeRelay(tmpDir), mockLogger());
    const ctx = await scorer.generateContext("Will AI surpass human intelligence?");
    expect(ctx).toContain("News headline");
  });

  it("scores with context", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "35.0" } }],
        usage: { prompt_tokens: 80, completion_tokens: 5, total_tokens: 85 },
      }),
    }));

    const scorer = new LitcreditScorer(makeRelay(tmpDir), mockLogger());
    const prob = await scorer.scoreProbabilityWithContext("test", 0.5, "Recent news suggests...");
    expect(prob).toBeCloseTo(0.35, 2);
  });

  it("reports configured status", () => {
    const scorer = new LitcreditScorer(makeRelay(tmpDir), mockLogger());
    expect(scorer.isConfigured).toBe(true);
  });
});
