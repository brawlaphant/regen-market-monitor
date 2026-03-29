import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { MultiVenueOrchestrator } from "../../src/strategies/multi-venue-orchestrator.js";
import { SurplusRouter } from "../../src/surplus/surplus-router.js";
import type { LitcreditScorer } from "../../src/scoring/litcredit-provider.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeScorer(configured: boolean): LitcreditScorer {
  return {
    scoreProbability: vi.fn().mockResolvedValue(null),
    scoreProbabilityWithContext: vi.fn().mockResolvedValue(null),
    generateContext: vi.fn().mockResolvedValue(null),
    analyze: vi.fn().mockResolvedValue(null),
    isConfigured: configured,
  } as unknown as LitcreditScorer;
}

describe("MultiVenueOrchestrator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "orchestrator-"));
    delete process.env.TRADING_DESK_DAILY_CAP;
    delete process.env.TRADING_DESK_SURPLUS_FLOOR;
    delete process.env.TRADING_DESK_SURPLUS_PCT;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("runs and returns result even when scorer is not configured", async () => {
    // Mock fetch for Polymarket (will fail since scorer is not configured)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => [],
    }));

    const scorer = makeScorer(false);
    const surplus = new SurplusRouter(tmpDir, mockLogger());
    const orch = new MultiVenueOrchestrator(scorer, surplus, tmpDir, mockLogger());

    const result = await orch.run();
    expect(result.timestamp).toBeDefined();
    expect(result.venues).toHaveLength(3);

    const polyResult = result.venues.find(v => v.venue === "polymarket");
    expect(polyResult).toBeDefined();
    expect(polyResult!.errors).toContain("LITCREDIT relay not configured — cannot score markets");
  });

  it("handles Hyperliquid package not installed gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => [],
    }));

    const scorer = makeScorer(false);
    const surplus = new SurplusRouter(tmpDir, mockLogger());
    const orch = new MultiVenueOrchestrator(scorer, surplus, tmpDir, mockLogger());

    const result = await orch.run();
    const hlResult = result.venues.find(v => v.venue === "hyperliquid");
    expect(hlResult).toBeDefined();
    // Should have an error (either package not found or some other graceful failure)
    // The exact error depends on whether hyperliquid is installed in dev
  });

  it("records P&L into surplus router after run", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => [],
    }));

    const scorer = makeScorer(false);
    const surplus = new SurplusRouter(tmpDir, mockLogger());
    const orch = new MultiVenueOrchestrator(scorer, surplus, tmpDir, mockLogger());

    await orch.run();
    const state = surplus.getState();
    // Both venues should have been recorded (even with 0 P&L)
    expect(Object.keys(state.venues)).toContain("polymarket");
    expect(Object.keys(state.venues)).toContain("hyperliquid");
  });

  it("saves artifact to disk", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => [],
    }));

    const scorer = makeScorer(false);
    const surplus = new SurplusRouter(tmpDir, mockLogger());
    const orch = new MultiVenueOrchestrator(scorer, surplus, tmpDir, mockLogger());

    await orch.run();
    const artifactDir = path.join(tmpDir, "trading-desk");
    expect(fs.existsSync(artifactDir)).toBe(true);
    const files = fs.readdirSync(artifactDir).filter(f => f.startsWith("run-"));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("includes surplus allocation in result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => [],
    }));

    const scorer = makeScorer(false);
    const surplus = new SurplusRouter(tmpDir, mockLogger());
    const orch = new MultiVenueOrchestrator(scorer, surplus, tmpDir, mockLogger());

    const result = await orch.run();
    expect(result.surplus_allocation).toBeDefined();
    expect(result.surplus_allocation.reason).toBeDefined();
  });

  it("accepts dryRun parameter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => [],
    }));

    const scorer = makeScorer(false);
    const surplus = new SurplusRouter(tmpDir, mockLogger());
    const orch = new MultiVenueOrchestrator(scorer, surplus, tmpDir, mockLogger());

    // Should not throw regardless of dryRun value
    const r1 = await orch.run(true);
    expect(r1.venues).toHaveLength(3);
    const r2 = await orch.run(false);
    expect(r2.venues).toHaveLength(3);
  });
});
