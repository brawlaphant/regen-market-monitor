import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpClient } from '../../src/mcp-client.js';
import { DataStore } from '../../src/data-store.js';
import { RegenMarketPlugin } from '../../src/plugins/regen-market-plugin.js';
import {
  createMockConfig,
  createMockLogger,
  createMockPriceHistory,
  mockRegenPrice,
  mockAvailableCredits,
  wrapMcpResponse,
} from '../helpers/mocks.js';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('anomaly detection (z-score)', () => {
  let tmpDir: string;
  let store: DataStore;
  let plugin: RegenMarketPlugin;
  const logger = createMockLogger();
  const config = createMockConfig();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'rmm-anomaly-'));
    store = new DataStore(tmpDir, logger);

    // Mock McpClient.prototype.callTool so no real network calls happen
    vi.spyOn(McpClient.prototype, 'callTool').mockImplementation(async (name: string) => {
      if (name === 'get_regen_price') {
        return wrapMcpResponse(mockRegenPrice());
      }
      if (name === 'browse_available_credits') {
        return wrapMcpResponse(mockAvailableCredits());
      }
      throw new Error(`Unexpected tool call: ${name}`);
    });

    plugin = new RegenMarketPlugin(
      new McpClient(config.regenComputeMcpUrl, config, logger),
      store,
      logger,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns insufficient_data when < 5 history points', async () => {
    // Start from empty history, run 3 times => only 3 data points
    let report = await plugin.detectPriceAnomaly();
    report = await plugin.detectPriceAnomaly();
    report = await plugin.detectPriceAnomaly();

    expect(report.status).toBe('insufficient_data');
    expect(report.z_score).toBe(0);
  });

  it('returns normal when z-score < 2.0', async () => {
    // Preload 10 prices with some spread so stddev is meaningful
    // Use prices that cluster around 0.042 with stddev ~0.002
    const flatHistory = Array.from({ length: 10 }, (_, i) => ({
      price_usd: 0.040 + i * 0.0004, // 0.040, 0.0404, 0.0408, ..., 0.0436
      timestamp: new Date(Date.now() - (10 - i) * 3600000).toISOString(),
    }));
    store.savePriceHistory(flatHistory);

    // Recreate plugin so it loads the preloaded history
    plugin = new RegenMarketPlugin(
      new McpClient(config.regenComputeMcpUrl, config, logger),
      store,
      logger,
    );

    // Call with a price near the median — small z-score
    // After appending, 11 values: 0.040..0.0436 + 0.042 => median ~0.042, stddev ~0.0012
    // z = |0.042 - median| / stddev should be well under 2.0
    vi.spyOn(McpClient.prototype, 'callTool').mockImplementation(async (name: string) => {
      if (name === 'get_regen_price') {
        return wrapMcpResponse(mockRegenPrice({ price_usd: 0.042 }));
      }
      if (name === 'browse_available_credits') {
        return wrapMcpResponse(mockAvailableCredits());
      }
      throw new Error(`Unexpected tool call: ${name}`);
    });

    const report = await plugin.detectPriceAnomaly();
    expect(report.status).toBe('normal');
    expect(report.z_score).toBeLessThan(2.0);
  });

  it('returns watchlist when z-score 2.0-3.49', async () => {
    // Use 10 identical prices so we can control stddev precisely
    // After adding the new price, we get 11 values: 10x baseline + 1x target
    // median of 11 values (10x 0.042 + 1x target): if target > 0.042, median = 0.042
    // stddev(sample): with 10x v and 1x t around mean m:
    //   mean = (10*0.042 + t)/11
    //   We need z = |t - median| / stddev in [2.0, 3.5)
    //
    // With 10x 0.042 and target = 0.046:
    //   median = 0.042 (6th of 11 sorted)
    //   mean = (10*0.042 + 0.046)/11 = 0.42036..
    //   variance = (10*(0.042-0.042036)^2 + (0.046-0.042036)^2)/10
    //   Let's just pick values and verify empirically
    const flatHistory = Array.from({ length: 10 }, (_, i) => ({
      price_usd: 0.042,
      timestamp: new Date(Date.now() - (10 - i) * 3600000).toISOString(),
    }));
    store.savePriceHistory(flatHistory);

    plugin = new RegenMarketPlugin(
      new McpClient(config.regenComputeMcpUrl, config, logger),
      store,
      logger,
    );

    // With 10x 0.042 + target, the code uses computeStdDev(prices, median)
    // where median=0.042 (middle of 11 sorted = 6th value = 0.042)
    // stdDev = sqrt(sum((p - 0.042)^2) / (11-1)) = sqrt((target-0.042)^2 / 10)
    //        = |target - 0.042| / sqrt(10) = |target - 0.042| * 0.3162
    // z = |target - 0.042| / stdDev = |target - 0.042| / (|target - 0.042| / sqrt(10))
    //   = sqrt(10) = 3.162
    // That's in [2.0, 3.5) -- perfect for watchlist!
    const targetPrice = 0.046;

    vi.spyOn(McpClient.prototype, 'callTool').mockImplementation(async (name: string) => {
      if (name === 'get_regen_price') {
        return wrapMcpResponse(mockRegenPrice({ price_usd: targetPrice }));
      }
      if (name === 'browse_available_credits') {
        return wrapMcpResponse(mockAvailableCredits());
      }
      throw new Error(`Unexpected tool call: ${name}`);
    });

    const report = await plugin.detectPriceAnomaly();
    expect(report.z_score).toBeGreaterThanOrEqual(2.0);
    expect(report.z_score).toBeLessThan(3.5);
    expect(report.status).toBe('watchlist');
  });

  it('returns flagged when z-score >= 3.5', async () => {
    // Use a mix of prices to create a stddev where an extreme value yields z >= 3.5
    // With 20 prices very tightly clustered and 1 extreme outlier:
    // Preload 20 prices between 0.0419 and 0.0421 (very tight cluster)
    const flatHistory = Array.from({ length: 20 }, (_, i) => ({
      price_usd: 0.042 + (i % 3 - 1) * 0.0001, // 0.0419, 0.042, 0.0421 repeating
      timestamp: new Date(Date.now() - (20 - i) * 3600000).toISOString(),
    }));
    store.savePriceHistory(flatHistory);

    plugin = new RegenMarketPlugin(
      new McpClient(config.regenComputeMcpUrl, config, logger),
      store,
      logger,
    );

    // After appending extreme price, 21 values with 20 tightly clustered around 0.042
    // median stays at ~0.042
    // stddev is small (~0.0001 range), extreme price at 0.060 is far away
    // z = |0.060 - 0.042| / stddev => very large
    const extremePrice = 0.060;

    vi.spyOn(McpClient.prototype, 'callTool').mockImplementation(async (name: string) => {
      if (name === 'get_regen_price') {
        return wrapMcpResponse(mockRegenPrice({ price_usd: extremePrice }));
      }
      if (name === 'browse_available_credits') {
        return wrapMcpResponse(mockAvailableCredits());
      }
      throw new Error(`Unexpected tool call: ${name}`);
    });

    const report = await plugin.detectPriceAnomaly();
    expect(report.z_score).toBeGreaterThanOrEqual(3.5);
    expect(report.status).toBe('flagged');
  });

  it('handles all identical prices (stddev=0) without division by zero', async () => {
    // Preload 10 identical prices — stddev will be 0
    const identicalHistory = Array.from({ length: 10 }, (_, i) => ({
      price_usd: 0.042,
      timestamp: new Date(Date.now() - (10 - i) * 3600000).toISOString(),
    }));
    store.savePriceHistory(identicalHistory);

    plugin = new RegenMarketPlugin(
      new McpClient(config.regenComputeMcpUrl, config, logger),
      store,
      logger,
    );

    // Call with the same price — stddev=0, code guards with `stdDev > 0 ? ... : 0`
    vi.spyOn(McpClient.prototype, 'callTool').mockImplementation(async (name: string) => {
      if (name === 'get_regen_price') {
        return wrapMcpResponse(mockRegenPrice({ price_usd: 0.042 }));
      }
      if (name === 'browse_available_credits') {
        return wrapMcpResponse(mockAvailableCredits());
      }
      throw new Error(`Unexpected tool call: ${name}`);
    });

    const report = await plugin.detectPriceAnomaly();
    // Should not throw, z_score should be 0 (guard against division by zero)
    expect(report.z_score).toBe(0);
    expect(report.status).toBe('normal');
    expect(Number.isFinite(report.z_score)).toBe(true);
  });

  it('computes correct price_change_pct', async () => {
    // Preload 5 history points so we have sufficient data and a known previous price
    const history = Array.from({ length: 5 }, (_, i) => ({
      price_usd: 0.040,
      timestamp: new Date(Date.now() - (5 - i) * 3600000).toISOString(),
    }));
    store.savePriceHistory(history);

    plugin = new RegenMarketPlugin(
      new McpClient(config.regenComputeMcpUrl, config, logger),
      store,
      logger,
    );

    const currentPrice = 0.050;
    vi.spyOn(McpClient.prototype, 'callTool').mockImplementation(async (name: string) => {
      if (name === 'get_regen_price') {
        return wrapMcpResponse(mockRegenPrice({ price_usd: currentPrice }));
      }
      if (name === 'browse_available_credits') {
        return wrapMcpResponse(mockAvailableCredits());
      }
      throw new Error(`Unexpected tool call: ${name}`);
    });

    const report = await plugin.detectPriceAnomaly();
    // previous price is the last element of preloaded history = 0.040
    // price_change_pct = (0.050 - 0.040) / 0.040 = 0.25
    expect(report.price_change_pct).toBeCloseTo(0.25, 4);
  });

  it('single price point returns insufficient_data', async () => {
    // Empty history, one call => 1 data point
    const report = await plugin.detectPriceAnomaly();

    expect(report.status).toBe('insufficient_data');
    expect(report.z_score).toBe(0);
  });
});
