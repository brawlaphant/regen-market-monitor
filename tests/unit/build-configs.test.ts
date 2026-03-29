import { describe, it, expect, afterEach } from "vitest";
import { buildRelayConfig } from "../../src/litcoin/index.js";
import { buildHyperliquidConfig } from "../../src/venues/hyperliquid/index.js";

describe("buildRelayConfig", () => {
  const envKeys = [
    "LITCOIN_WALLET", "LITCOIN_RELAY_KEY", "LITCREDIT_RELAY_URL",
    "LITCREDIT_TIMEOUT_MS", "LITCREDIT_RETRY_TIMEOUT_MS", "LITCREDIT_MODEL",
  ];

  afterEach(() => {
    for (const k of envKeys) delete process.env[k];
  });

  it("defaults to authMethod=none when no env vars set", () => {
    const config = buildRelayConfig();
    expect(config.authMethod).toBe("none");
    expect(config.wallet).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
  });

  it("prefers wallet auth when LITCOIN_WALLET set", () => {
    process.env.LITCOIN_WALLET = "0xabc";
    process.env.LITCOIN_RELAY_KEY = "key123";
    const config = buildRelayConfig();
    expect(config.authMethod).toBe("wallet");
    expect(config.wallet).toBe("0xabc");
  });

  it("falls back to key auth when only LITCOIN_RELAY_KEY set", () => {
    process.env.LITCOIN_RELAY_KEY = "key123";
    const config = buildRelayConfig();
    expect(config.authMethod).toBe("key");
    expect(config.apiKey).toBe("key123");
  });

  it("strips trailing slashes from relay URL", () => {
    process.env.LITCREDIT_RELAY_URL = "https://relay.example.com/v1///";
    const config = buildRelayConfig();
    expect(config.baseUrl).toBe("https://relay.example.com/v1");
  });

  it("uses default URL when not set", () => {
    const config = buildRelayConfig();
    expect(config.baseUrl).toBe("https://api.litcoiin.xyz/v1");
  });

  it("parses timeout from env", () => {
    process.env.LITCREDIT_TIMEOUT_MS = "10000";
    const config = buildRelayConfig();
    expect(config.timeoutMs).toBe(10000);
  });

  it("falls back to defaults for non-numeric timeout", () => {
    process.env.LITCREDIT_TIMEOUT_MS = "banana";
    process.env.LITCREDIT_RETRY_TIMEOUT_MS = "nope";
    const config = buildRelayConfig();
    expect(config.timeoutMs).toBe(45000);
    expect(config.retryTimeoutMs).toBe(120000);
  });

  it("uses custom model when set", () => {
    process.env.LITCREDIT_MODEL = "gemini-2.5-flash";
    const config = buildRelayConfig();
    expect(config.model).toBe("gemini-2.5-flash");
  });
});

describe("buildHyperliquidConfig", () => {
  const envKeys = [
    "HYPERLIQUID_PK", "HYPERLIQUID_DRY_RUN", "HYPERLIQUID_DAILY_CAP",
    "HYPERLIQUID_MAX_POSITION", "HYPERLIQUID_MAX_LEVERAGE",
    "HYPERLIQUID_FUNDING_THRESHOLD", "HYPERLIQUID_MOMENTUM_THRESHOLD",
    "HYPERLIQUID_MIN_VOLUME",
  ];

  afterEach(() => {
    for (const k of envKeys) delete process.env[k];
  });

  it("defaults dryRun to true", () => {
    const config = buildHyperliquidConfig();
    expect(config.dryRun).toBe(true);
  });

  it("sets dryRun=false when HYPERLIQUID_DRY_RUN=false", () => {
    process.env.HYPERLIQUID_DRY_RUN = "false";
    const config = buildHyperliquidConfig();
    expect(config.dryRun).toBe(false);
  });

  it("handles case-insensitive HYPERLIQUID_DRY_RUN=FALSE", () => {
    process.env.HYPERLIQUID_DRY_RUN = "FALSE";
    const config = buildHyperliquidConfig();
    expect(config.dryRun).toBe(false);
  });

  it("populates privateKey when HYPERLIQUID_PK set", () => {
    process.env.HYPERLIQUID_PK = "0xdeadbeef";
    const config = buildHyperliquidConfig();
    expect(config.privateKey).toBe("0xdeadbeef");
  });

  it("returns undefined privateKey when not set", () => {
    const config = buildHyperliquidConfig();
    expect(config.privateKey).toBeUndefined();
  });

  it("uses default numeric values", () => {
    const config = buildHyperliquidConfig();
    expect(config.dailyCap).toBe(50);
    expect(config.maxPosition).toBe(25);
    expect(config.maxLeverage).toBe(5);
    expect(config.fundingThreshold).toBe(0.01);
    expect(config.momentumThreshold).toBe(0.02);
    expect(config.minVolume24h).toBe(1_000_000);
  });

  it("parses numeric values from env", () => {
    process.env.HYPERLIQUID_DAILY_CAP = "100";
    process.env.HYPERLIQUID_MAX_LEVERAGE = "3";
    const config = buildHyperliquidConfig();
    expect(config.dailyCap).toBe(100);
    expect(config.maxLeverage).toBe(3);
  });

  it("falls back to defaults for non-numeric env vars", () => {
    process.env.HYPERLIQUID_DAILY_CAP = "banana";
    process.env.HYPERLIQUID_MAX_LEVERAGE = "nope";
    process.env.HYPERLIQUID_MIN_VOLUME = "";
    const config = buildHyperliquidConfig();
    expect(config.dailyCap).toBe(50);
    expect(config.maxLeverage).toBe(5);
    expect(config.minVolume24h).toBe(1_000_000);
  });
});
