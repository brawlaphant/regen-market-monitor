import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CoinstoreVolumeStrategy } from "../../src/strategies/coinstore-volume-strategy.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("CoinstoreVolumeStrategy", () => {
  afterEach(() => {
    delete process.env.COINSTORE_API_KEY;
    delete process.env.COINSTORE_API_SECRET;
    delete process.env.COINSTORE_VOLUME_BOOST_ENABLED;
  });

  it("is not configured without API keys", () => {
    const strategy = new CoinstoreVolumeStrategy(mockLogger());
    expect(strategy.isConfigured).toBe(false);
  });

  it("is configured with API keys", () => {
    process.env.COINSTORE_API_KEY = "test-key";
    process.env.COINSTORE_API_SECRET = "test-secret";
    const strategy = new CoinstoreVolumeStrategy(mockLogger());
    expect(strategy.isConfigured).toBe(true);
  });

  it("getMarketHealth returns null when not configured", async () => {
    const strategy = new CoinstoreVolumeStrategy(mockLogger());
    const health = await strategy.getMarketHealth();
    expect(health).toBeNull();
  });

  it("volume boost returns false when not enabled", async () => {
    const strategy = new CoinstoreVolumeStrategy(mockLogger());
    const result = await strategy.runVolumeBoost();
    expect(result).toBe(false);
  });

  it("volume boost returns false when boost disabled", async () => {
    process.env.COINSTORE_API_KEY = "key";
    process.env.COINSTORE_API_SECRET = "secret";
    process.env.COINSTORE_VOLUME_BOOST_ENABLED = "false";
    const strategy = new CoinstoreVolumeStrategy(mockLogger());
    const result = await strategy.runVolumeBoost();
    expect(result).toBe(false);
  });
});
