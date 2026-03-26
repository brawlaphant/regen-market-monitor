import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AlertManager } from "../../src/alerts.js";
import { DataStore } from "../../src/data-store.js";
import { McpClient } from "../../src/mcp-client.js";
import { RegenMarketPlugin } from "../../src/plugins/regen-market-plugin.js";
import {
  createMockConfig,
  createMockLogger,
  createMockAnomalyReport,
  createMockLiquidityReport,
  createMockRetirementReport,
  mockRegenPrice,
  mockSupplyHealth,
  mockAvailableCredits,
  mockCommunityGoals,
  wrapMcpResponse,
} from "../helpers/mocks.js";
import type { MarketAlert } from "../../src/types.js";

describe("Branch coverage: AlertManager", () => {
  let tmpDir: string;
  let alerts: AlertManager;
  let fired: MarketAlert[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "br-"));
    const config = createMockConfig({ dataDir: tmpDir, alertCooldownMs: 0 });
    const store = new DataStore(tmpDir, createMockLogger());
    alerts = new AlertManager(config, store, createMockLogger());
    fired = [];
    alerts.onAlert((a) => fired.push(a));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("health_score < 50 but >= 30 fires WARNING not CRITICAL", async () => {
    await alerts.checkLiquidity(createMockLiquidityReport({ health_score: 45 }));
    expect(fired).toHaveLength(1);
    expect(fired[0].severity).toBe("WARNING");
    expect(fired[0].title).toBe("Market Health Declining");
  });

  it("health_score >= 50 fires nothing", async () => {
    await alerts.checkLiquidity(createMockLiquidityReport({ health_score: 72 }));
    expect(fired).toHaveLength(0);
  });

  it("checkRetirements with high demand signal fires INFO", async () => {
    const report = createMockRetirementReport({ demand_signal: "high" });
    await alerts.checkRetirements(report);
    const demand = fired.find((a) => a.title === "High Retirement Demand");
    expect(demand).toBeDefined();
    expect(demand!.severity).toBe("INFO");
  });

  it("checkRetirements with moderate demand fires nothing", async () => {
    const report = createMockRetirementReport({ demand_signal: "moderate" });
    await alerts.checkRetirements(report);
    expect(fired).toHaveLength(0);
  });

  it("checkCuration with score >= 300 fires nothing", async () => {
    await alerts.checkCuration({ quality_score: 500, factor_breakdown: {}, degraded_batches: [], timestamp: new Date() });
    expect(fired).toHaveLength(0);
  });

  it("checkAnomaly with insufficient_data fires nothing", async () => {
    const report = createMockAnomalyReport("normal", { status: "insufficient_data", z_score: 0 });
    await alerts.checkAnomaly(report, 0.04);
    expect(fired).toHaveLength(0);
  });

  it("checkAnomaly with no lastPrice skips price move check", async () => {
    const report = createMockAnomalyReport("normal");
    await alerts.checkAnomaly(report, undefined);
    expect(fired).toHaveLength(0);
  });

  it("recordPrice and trend computation works", () => {
    alerts.recordPrice(0.04);
    alerts.recordPrice(0.05);
    alerts.recordPrice(0.03);
    alerts.recordPrice(0.06);
    alerts.recordPrice(0.04); // Overflow trims to 4
  });
});

describe("Branch coverage: RegenMarketPlugin", () => {
  let tmpDir: string;
  let mcp: McpClient;
  let plugin: RegenMarketPlugin;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "br-plug-"));
    const config = createMockConfig({ dataDir: tmpDir });
    const store = new DataStore(tmpDir, createMockLogger());
    mcp = new McpClient("http://mock", config, createMockLogger());
    plugin = new RegenMarketPlugin(mcp, store, createMockLogger());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("assessLiquidity validates both MCP responses", async () => {
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      if (name === "check_supply_health") return wrapMcpResponse(mockSupplyHealth());
      return wrapMcpResponse(mockAvailableCredits());
    });

    const report = await plugin.assessLiquidity();
    expect(report.health_score).toBe(72);
    expect(report.available_credits).toBe(5000);
  });

  it("scoreCurationQuality handles empty credits", async () => {
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      if (name === "browse_available_credits")
        return wrapMcpResponse(mockAvailableCredits({ credits: [], total_listed_value_usd: 0, total_tradable: 0 }));
      return wrapMcpResponse(mockSupplyHealth());
    });

    const report = await plugin.scoreCurationQuality();
    expect(report.quality_score).toBeGreaterThanOrEqual(0);
  });

  it("scoreCurationQuality computes vintage freshness and price fairness", async () => {
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      if (name === "browse_available_credits") return wrapMcpResponse(mockAvailableCredits());
      return wrapMcpResponse(mockSupplyHealth());
    });

    const report = await plugin.scoreCurationQuality();
    expect(report.factor_breakdown.vintage_freshness).toBeGreaterThan(0);
    expect(report.factor_breakdown.price_fairness).toBeGreaterThan(0);
  });

  it("analyzeRetirements detects high demand signal", async () => {
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      if (name === "get_community_goals") {
        return wrapMcpResponse(mockCommunityGoals({
          goals: [
            { id: "g1", name: "G1", target: 100, current: 100, percent_complete: 100 },
            { id: "g2", name: "G2", target: 100, current: 100, percent_complete: 100 },
          ],
        }));
      }
      return wrapMcpResponse(mockSupplyHealth());
    });

    const report = await plugin.analyzeRetirements();
    expect(report.demand_signal).toBe("high");
    expect(report.completed_goals).toHaveLength(2);
  });

  it("analyzeRetirements detects low demand signal", async () => {
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      if (name === "get_community_goals") {
        return wrapMcpResponse(mockCommunityGoals({
          goals: [{ id: "g1", name: "G1", target: 100, current: 10, percent_complete: 10 }],
        }));
      }
      return wrapMcpResponse(mockSupplyHealth());
    });

    const report = await plugin.analyzeRetirements();
    expect(report.demand_signal).toBe("low");
  });

  it("buildSnapshot produces valid snapshot", () => {
    const snap = plugin.buildSnapshot(null, null, null, null, 100);
    expect(snap.lastPollAt).toBeDefined();
    expect(snap.pollDurationMs).toBe(100);
  });

  it("flushPriceHistory writes to disk", () => {
    plugin.flushPriceHistory();
    // Should not throw even with empty history
  });

  it("detectPriceAnomaly handles credits validation failure gracefully", async () => {
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      if (name === "get_regen_price") return wrapMcpResponse(mockRegenPrice());
      // Return invalid credits shape
      return wrapMcpResponse({ invalid: true });
    });

    // Should still work — credits validation failure is non-blocking
    const report = await plugin.detectPriceAnomaly();
    expect(report.current_price).toBe(0.042);
  });
});

describe("Branch coverage: ThresholdTuner", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "br-tune-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("buildTuningReport with not-ready report", async () => {
    const { ThresholdTuner } = await import("../../src/tuner/threshold-tuner.js");
    const config = createMockConfig({ dataDir: tmpDir });
    const tuner = new ThresholdTuner(config, createMockLogger());
    const report = tuner.analyze();
    const md = tuner.buildTuningReport(report);
    expect(md).toContain("Not ready");
  });

  it("buildTuningReport with ready report", async () => {
    const { ThresholdTuner } = await import("../../src/tuner/threshold-tuner.js");
    // Write enough data
    const now = Date.now();
    const startMs = now - 10 * 24 * 60 * 60 * 1000;
    const lastFired: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      lastFired[`Low Credit Stock ${i}`] = startMs + i * 24 * 60 * 60 * 1000;
    }
    fs.writeFileSync(path.join(tmpDir, "alert-state.json"), JSON.stringify({
      lastFired, alertsFiredToday: 0, dayStart: now,
    }));

    const config = createMockConfig({ dataDir: tmpDir });
    const tuner = new ThresholdTuner(config, createMockLogger());
    const report = tuner.analyze();
    expect(report.ready).toBe(true);
    const md = tuner.buildTuningReport(report);
    expect(md).toContain("Threshold");
    expect(md).toContain("Suggested");
    expect(md).toContain("Disclaimer");
  });
});
