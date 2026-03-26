import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Scheduler } from "../../src/scheduler.js";
import { RegenMarketPlugin } from "../../src/plugins/regen-market-plugin.js";
import { AlertManager } from "../../src/alerts.js";
import { DataStore } from "../../src/data-store.js";
import { HealthServer } from "../../src/health-server.js";
import { TelegramNotifier } from "../../src/notifiers/telegram.js";
import {
  createMockConfig,
  createMockLogger,
  createMockAnomalyReport,
  createMockLiquidityReport,
  createMockRetirementReport,
} from "../helpers/mocks.js";

vi.mock("../../src/plugins/regen-market-plugin.js");
vi.mock("../../src/alerts.js");
vi.mock("../../src/data-store.js");
vi.mock("../../src/health-server.js");
vi.mock("../../src/notifiers/telegram.js");

describe("Scheduler", () => {
  let scheduler: Scheduler;
  let plugin: any;
  let alerts: any;
  let store: any;
  let health: any;
  let notifier: any;
  const config = createMockConfig({ pollIntervalMs: 10000 });
  const logger = createMockLogger();

  beforeEach(() => {
    vi.useFakeTimers();

    plugin = {
      detectPriceAnomaly: vi.fn().mockResolvedValue(createMockAnomalyReport("normal")),
      assessLiquidity: vi.fn().mockResolvedValue(createMockLiquidityReport()),
      analyzeRetirements: vi.fn().mockResolvedValue(createMockRetirementReport()),
      scoreCurationQuality: vi.fn().mockResolvedValue({ quality_score: 700, factor_breakdown: {}, degraded_batches: [], timestamp: new Date() }),
      buildSnapshot: vi.fn().mockReturnValue({ lastPollAt: new Date().toISOString(), pollDurationMs: 100 }),
      flushPriceHistory: vi.fn(),
      lastPrice: null,
      lastSupplyHealth: null,
    };

    alerts = {
      checkAnomaly: vi.fn(),
      checkLiquidity: vi.fn(),
      checkRetirements: vi.fn(),
      checkCuration: vi.fn(),
      recordPrice: vi.fn(),
      emitMcpUnreachable: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn(),
      alertsFiredToday: 0,
    };

    store = {
      loadSnapshot: vi.fn().mockReturnValue(null),
      saveSnapshot: vi.fn(),
      waitForWrites: vi.fn().mockResolvedValue(undefined),
    };

    health = {
      snapshot: null,
      lastPollAt: null,
      nextPollAt: null,
      mcpReachable: true,
      alertsFiredToday: 0,
      close: vi.fn().mockResolvedValue(undefined),
    };

    notifier = {
      sendDigest: vi.fn().mockResolvedValue(undefined),
    };

    // Prevent process.exit and process.on from interfering
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    scheduler = new Scheduler(plugin, alerts, store, health, notifier, config, logger);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs all workflows immediately on startup", async () => {
    await scheduler.start();

    expect(plugin.detectPriceAnomaly).toHaveBeenCalledTimes(1);
    expect(plugin.assessLiquidity).toHaveBeenCalledTimes(1);
    expect(plugin.scoreCurationQuality).toHaveBeenCalledTimes(1);
    // Retirement runs on initial
    expect(plugin.analyzeRetirements).toHaveBeenCalledTimes(1);
  });

  it("triggers workflows every POLL_INTERVAL_MS", async () => {
    await scheduler.start();

    expect(plugin.detectPriceAnomaly).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10000);
    expect(plugin.detectPriceAnomaly).toHaveBeenCalledTimes(2);
    expect(plugin.assessLiquidity).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10000);
    expect(plugin.detectPriceAnomaly).toHaveBeenCalledTimes(3);
  });

  it("runs retirements only once per 24h", async () => {
    await scheduler.start();
    expect(plugin.analyzeRetirements).toHaveBeenCalledTimes(1);

    // Advance by 1 poll interval — should NOT run retirements again
    await vi.advanceTimersByTimeAsync(10000);
    expect(plugin.analyzeRetirements).toHaveBeenCalledTimes(1);

    // Advance past 24h — should run retirements
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(plugin.analyzeRetirements).toHaveBeenCalledTimes(2);
  });

  it("continues other workflows when one fails", async () => {
    plugin.detectPriceAnomaly.mockRejectedValueOnce(new Error("MCP down"));

    await scheduler.start();

    // Price anomaly failed but others should still run
    expect(plugin.assessLiquidity).toHaveBeenCalledTimes(1);
    expect(plugin.scoreCurationQuality).toHaveBeenCalledTimes(1);
  });

  it("flushes data on graceful shutdown", async () => {
    await scheduler.start();

    await scheduler.stop("SIGINT");

    expect(plugin.flushPriceHistory).toHaveBeenCalled();
    expect(alerts.flush).toHaveBeenCalled();
    expect(store.waitForWrites).toHaveBeenCalled();
    expect(health.close).toHaveBeenCalled();
  });
});
