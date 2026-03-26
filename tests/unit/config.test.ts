import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("loadConfig", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.REGEN_COMPUTE_MCP_URL = "http://test:3100/mcp";
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  async function loadFresh() {
    // Dynamic import to pick up env changes
    const mod = await import("../../src/config.js");
    return mod.loadConfig();
  }

  it("throws when REGEN_COMPUTE_MCP_URL is missing", async () => {
    delete process.env.REGEN_COMPUTE_MCP_URL;
    await expect(loadFresh()).rejects.toThrow("REGEN_COMPUTE_MCP_URL is required");
  });

  it("returns config with defaults", async () => {
    const config = await loadFresh();
    expect(config.regenComputeMcpUrl).toBe("http://test:3100/mcp");
    expect(config.pollIntervalMs).toBe(3600000);
    expect(config.lowStockThreshold).toBe(1000);
    expect(config.priceMoveThreshold).toBe(0.10);
    expect(config.alertCooldownMs).toBe(3600000);
    expect(config.logLevel).toBe("info");
    expect(config.port).toBe(3099);
    expect(config.dailyDigestHourUtc).toBe(9);
    expect(config.dataDir).toBe("./data");
    expect(config.mcpTimeoutMs).toBe(10000);
    expect(config.mcpRetryAttempts).toBe(3);
  });

  it("reads custom env values", async () => {
    process.env.POLL_INTERVAL_MS = "5000";
    process.env.LOW_STOCK_THRESHOLD = "500";
    process.env.PRICE_MOVE_THRESHOLD = "0.25";
    process.env.LOG_LEVEL = "debug";

    const config = await loadFresh();
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.lowStockThreshold).toBe(500);
    expect(config.priceMoveThreshold).toBe(0.25);
    expect(config.logLevel).toBe("debug");
  });

  it("telegram vars are undefined when not set", async () => {
    const config = await loadFresh();
    expect(config.telegramBotToken).toBeUndefined();
    expect(config.telegramChatId).toBeUndefined();
  });
});
