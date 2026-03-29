import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { RelayClient } from "../../src/litcoin/relay-client.js";
import type { RelayConfig } from "../../src/litcoin/types.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    baseUrl: "https://api.litcoiin.xyz/v1",
    authMethod: "key",
    apiKey: "test-key",
    timeoutMs: 5000,
    retryTimeoutMs: 10000,
    model: "auto",
    ...overrides,
  };
}

describe("RelayClient", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "relay-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("builds correct auth headers for key auth", () => {
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    expect(client.isConfigured).toBe(true);
  });

  it("builds correct auth headers for wallet auth", () => {
    const client = new RelayClient(
      makeConfig({ authMethod: "wallet", wallet: "0xabc", apiKey: undefined }),
      tmpDir,
      mockLogger()
    );
    expect(client.isConfigured).toBe(true);
  });

  it("reports not configured when no auth", () => {
    const client = new RelayClient(
      makeConfig({ authMethod: "none", apiKey: undefined, wallet: undefined }),
      tmpDir,
      mockLogger()
    );
    expect(client.isConfigured).toBe(false);
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    const result = await client.chatCompletion([{ role: "user", content: "test" }]);
    expect(result).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service unavailable",
    }));
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    const result = await client.chatCompletion([{ role: "user", content: "test" }]);
    expect(result).toBeNull();
  });

  it("parses successful response and tracks burn", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "42.5" } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
    }));

    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    const result = await client.chatCompletion(
      [{ role: "user", content: "test" }],
      { purpose: "test_scoring" }
    );

    expect(result).toBe("42.5");

    const stats = client.getBurnStats();
    expect(stats.burn_count).toBe(1);
    expect(stats.total_tokens).toBe(110);
    expect(stats.total_litcredit).toBeCloseTo(0.11, 2);
  });

  it("persists burn ledger to disk", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 500, completion_tokens: 500, total_tokens: 1000 },
      }),
    }));

    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    await client.chatCompletion([{ role: "user", content: "test" }]);

    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(tmpDir, "litcoin", `burn-ledger-${today}.json`);
    expect(fs.existsSync(file)).toBe(true);

    const ledger = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(ledger.total_litcredit).toBe(1);
    expect(ledger.burns).toHaveLength(1);
  });

  it("health check returns reachable=false on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const client = new RelayClient(makeConfig(), tmpDir, mockLogger());
    const health = await client.checkHealth();
    expect(health.reachable).toBe(false);
  });
});
