import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { McpClient } from "../../src/mcp-client.js";
import { DataStore } from "../../src/data-store.js";
import { RegenMarketPlugin } from "../../src/plugins/regen-market-plugin.js";
import { AlertManager } from "../../src/alerts.js";
import {
  createMockConfig,
  createMockLogger,
  mockSupplyHealth,
  mockRegenPrice,
  mockAvailableCredits,
  mockCommunityGoals,
  wrapMcpResponse,
} from "../helpers/mocks.js";
import type { MarketAlert } from "../../src/types.js";

describe("Integration: Full Poll Cycle", () => {
  let tmpDir: string;
  let store: DataStore;
  let mcp: McpClient;
  let plugin: RegenMarketPlugin;
  let alerts: AlertManager;
  let firedAlerts: MarketAlert[];
  const logger = createMockLogger();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "rmm-int-"));
    const config = createMockConfig({ dataDir: tmpDir, alertCooldownMs: 0 });
    store = new DataStore(tmpDir, logger);
    mcp = new McpClient("http://mock:3100/mcp", config, logger);
    plugin = new RegenMarketPlugin(mcp, store, logger);
    alerts = new AlertManager(config, store, logger);
    firedAlerts = [];
    alerts.onAlert((alert) => { firedAlerts.push(alert); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("happy path: normal values produce no alerts", async () => {
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      switch (name) {
        case "get_regen_price": return wrapMcpResponse(mockRegenPrice());
        case "browse_available_credits": return wrapMcpResponse(mockAvailableCredits());
        case "check_supply_health": return wrapMcpResponse(mockSupplyHealth());
        case "get_community_goals": return wrapMcpResponse(mockCommunityGoals());
        default: throw new Error(`Unknown tool: ${name}`);
      }
    });

    const anomaly = await plugin.detectPriceAnomaly();
    await alerts.checkAnomaly(anomaly);

    const liquidity = await plugin.assessLiquidity();
    await alerts.checkLiquidity(liquidity);

    const retirements = await plugin.analyzeRetirements();
    await alerts.checkRetirements(retirements);

    const curation = await plugin.scoreCurationQuality();
    await alerts.checkCuration(curation);

    // Normal values → no alerts
    expect(firedAlerts.length).toBe(0);
  });

  it("low stock scenario fires WARNING", async () => {
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      switch (name) {
        case "check_supply_health":
          return wrapMcpResponse(mockSupplyHealth({ available_credits: 50 }));
        case "browse_available_credits":
          return wrapMcpResponse(mockAvailableCredits());
        default:
          return wrapMcpResponse(mockRegenPrice());
      }
    });

    const liquidity = await plugin.assessLiquidity();
    await alerts.checkLiquidity(liquidity);

    expect(firedAlerts.length).toBeGreaterThanOrEqual(1);
    const lowStock = firedAlerts.find((a) => a.title === "Low Credit Stock");
    expect(lowStock).toBeDefined();
    expect(lowStock!.severity).toBe("WARNING");
  });

  it("price spike scenario fires PRICE_MOVE alert", async () => {
    // First call establishes baseline
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      if (name === "get_regen_price") return wrapMcpResponse(mockRegenPrice({ price_usd: 0.04 }));
      return wrapMcpResponse(mockAvailableCredits());
    });

    const first = await plugin.detectPriceAnomaly();
    await alerts.checkAnomaly(first, undefined);
    const lastPrice = first.current_price;

    // Second call with 25% spike
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      if (name === "get_regen_price") return wrapMcpResponse(mockRegenPrice({ price_usd: 0.05 }));
      return wrapMcpResponse(mockAvailableCredits());
    });

    const second = await plugin.detectPriceAnomaly();
    await alerts.checkAnomaly(second, lastPrice);

    const priceAlert = firedAlerts.find((a) => a.title === "Significant Price Movement");
    expect(priceAlert).toBeDefined();
    expect(priceAlert!.severity).toBe("WARNING");
  });

  it("goal completion fires INFO alert", async () => {
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      if (name === "get_community_goals") {
        return wrapMcpResponse(mockCommunityGoals({
          goals: [{ id: "g1", name: "Test Goal", target: 1000, current: 1000, percent_complete: 100 }],
        }));
      }
      return wrapMcpResponse(mockSupplyHealth());
    });

    const retirements = await plugin.analyzeRetirements();
    await alerts.checkRetirements(retirements);

    const goalAlert = firedAlerts.find((a) => a.title === "Community Goal Completed");
    expect(goalAlert).toBeDefined();
    expect(goalAlert!.severity).toBe("INFO");
  });

  it("MCP failure: other workflows still complete", async () => {
    let callCount = 0;
    vi.spyOn(mcp, "callTool").mockImplementation(async (name) => {
      callCount++;
      if (name === "get_regen_price") throw new Error("MCP unavailable");
      if (name === "check_supply_health") return wrapMcpResponse(mockSupplyHealth());
      if (name === "browse_available_credits") return wrapMcpResponse(mockAvailableCredits());
      if (name === "get_community_goals") return wrapMcpResponse(mockCommunityGoals());
      throw new Error("Unknown");
    });

    // Price anomaly will fail
    let anomalyFailed = false;
    try {
      await plugin.detectPriceAnomaly();
    } catch {
      anomalyFailed = true;
    }
    expect(anomalyFailed).toBe(true);

    // But liquidity still works
    const liquidity = await plugin.assessLiquidity();
    expect(liquidity.health_score).toBe(72);
  });

  it("all-MCP-failure: agent survives", async () => {
    vi.spyOn(mcp, "callTool").mockRejectedValue(new Error("All MCP down"));

    const errors: string[] = [];

    try { await plugin.detectPriceAnomaly(); } catch { errors.push("WF-MM-01"); }
    try { await plugin.assessLiquidity(); } catch { errors.push("WF-MM-02"); }
    try { await plugin.analyzeRetirements(); } catch { errors.push("WF-MM-03"); }
    try { await plugin.scoreCurationQuality(); } catch { errors.push("WF-MM-04"); }

    expect(errors).toEqual(["WF-MM-01", "WF-MM-02", "WF-MM-03", "WF-MM-04"]);
    // Agent process is still alive — no unhandled throws
  });
});
