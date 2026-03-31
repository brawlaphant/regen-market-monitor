import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { RetirementAttribution } from "../../src/surplus/retirement-attribution.js";
import { SurplusRouter } from "../../src/surplus/surplus-router.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("RetirementAttribution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "retire-attr-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a memo with attribution text", () => {
    const attr = new RetirementAttribution(tmpDir, mockLogger());
    const memo = attr.generateMemo();
    expect(memo).toContain("regen-market-monitor contributors");
    expect(memo).toContain("Trading profits");
    expect(memo).toContain("ecological regeneration");
    expect(memo).toContain("github.com/brawlaphant/regen-market-monitor");
  });

  it("includes credit class and batch in memo when provided", () => {
    const attr = new RetirementAttribution(tmpDir, mockLogger());
    const memo = attr.generateMemo({
      credit_class: "C01",
      batch_denom: "C01-001-20200101-20201231-001",
      usd_value: 25.50,
    });
    expect(memo).toContain("Credit class: C01");
    expect(memo).toContain("Batch: C01-001-20200101-20201231-001");
    expect(memo).toContain("Funded: $25.50");
  });

  it("starts with zero stats", () => {
    const attr = new RetirementAttribution(tmpDir, mockLogger());
    const stats = attr.getStats();
    expect(stats.total_retired_credits).toBe(0);
    expect(stats.total_usd_value).toBe(0);
    expect(stats.retirements_count).toBe(0);
    expect(stats.latest_retirement_tx).toBeNull();
    expect(stats.avg_usd_per_retirement).toBe(0);
  });

  it("records a retirement and updates stats", () => {
    const attr = new RetirementAttribution(tmpDir, mockLogger());
    const record = attr.recordRetirement({
      timestamp: new Date().toISOString(),
      credits_retired: 10,
      credit_class: "C01",
      batch_denom: "C01-001-20200101-20201231-001",
      usd_value: 5.00,
      surplus_source_usd: 5.00,
      tx_hash: "ABC123HASH",
      jurisdiction: "US-CA",
    });

    expect(record.id).toMatch(/^ret-/);
    expect(record.memo).toContain("regen-market-monitor contributors");

    const stats = attr.getStats();
    expect(stats.total_retired_credits).toBe(10);
    expect(stats.total_usd_value).toBe(5.00);
    expect(stats.retirements_count).toBe(1);
    expect(stats.latest_retirement_tx).toBe("ABC123HASH");
    expect(stats.credit_classes).toEqual({ C01: 10 });
  });

  it("aggregates multiple retirements", () => {
    const attr = new RetirementAttribution(tmpDir, mockLogger());

    attr.recordRetirement({
      timestamp: new Date().toISOString(),
      credits_retired: 10,
      credit_class: "C01",
      batch_denom: "C01-001",
      usd_value: 5.00,
      surplus_source_usd: 5.00,
      tx_hash: "TX1",
      jurisdiction: "US-CA",
    });

    attr.recordRetirement({
      timestamp: new Date().toISOString(),
      credits_retired: 25,
      credit_class: "C02",
      batch_denom: "C02-001",
      usd_value: 12.50,
      surplus_source_usd: 12.50,
      tx_hash: "TX2",
      jurisdiction: "US-CA",
    });

    attr.recordRetirement({
      timestamp: new Date().toISOString(),
      credits_retired: 5,
      credit_class: "C01",
      batch_denom: "C01-002",
      usd_value: 2.50,
      surplus_source_usd: 2.50,
      tx_hash: "TX3",
      jurisdiction: "US-OR",
    });

    const stats = attr.getStats();
    expect(stats.total_retired_credits).toBe(40);
    expect(stats.total_usd_value).toBe(20.00);
    expect(stats.retirements_count).toBe(3);
    expect(stats.latest_retirement_tx).toBe("TX3");
    expect(stats.credit_classes).toEqual({ C01: 15, C02: 25 });
    expect(stats.avg_usd_per_retirement).toBeCloseTo(6.67, 1);
  });

  it("persists state across instances", () => {
    const attr1 = new RetirementAttribution(tmpDir, mockLogger());
    attr1.recordRetirement({
      timestamp: new Date().toISOString(),
      credits_retired: 100,
      credit_class: "C01",
      batch_denom: "C01-001",
      usd_value: 50.00,
      surplus_source_usd: 50.00,
      tx_hash: "PERSIST_TX",
      jurisdiction: "US-CA",
    });

    // New instance from same data dir
    const attr2 = new RetirementAttribution(tmpDir, mockLogger());
    const stats = attr2.getStats();
    expect(stats.total_retired_credits).toBe(100);
    expect(stats.total_usd_value).toBe(50.00);
    expect(stats.retirements_count).toBe(1);
    expect(stats.latest_retirement_tx).toBe("PERSIST_TX");
  });

  it("returns recent records most-recent-first", () => {
    const attr = new RetirementAttribution(tmpDir, mockLogger());
    for (let i = 0; i < 5; i++) {
      attr.recordRetirement({
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        credits_retired: 1,
        credit_class: "C01",
        batch_denom: `C01-${i}`,
        usd_value: 1.00,
        surplus_source_usd: 1.00,
        tx_hash: `TX-${i}`,
        jurisdiction: "US-CA",
      });
    }

    const recent = attr.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].tx_hash).toBe("TX-4");
    expect(recent[2].tx_hash).toBe("TX-2");
  });

  it("getStatsResponse includes surplus context", () => {
    const attr = new RetirementAttribution(tmpDir, mockLogger());
    attr.recordRetirement({
      timestamp: new Date().toISOString(),
      credits_retired: 10,
      credit_class: "C01",
      batch_denom: "C01-001",
      usd_value: 5.00,
      surplus_source_usd: 5.00,
      tx_hash: "TX1",
      jurisdiction: "US-CA",
    });

    const resp = attr.getStatsResponse(25.00);
    expect(resp.stats.retirements_count).toBe(1);
    expect(resp.surplus_context.cumulative_surplus_routed_usd).toBe(25.00);
    expect(resp.surplus_context.cumulative_retired_usd).toBe(5.00);
    expect(resp.surplus_context.pending_retirement_usd).toBe(20.00);
  });
});

describe("SurplusRouter + RetirementAttribution integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "surplus-retire-"));
    process.env.TRADING_DESK_SURPLUS_FLOOR = "10";
    process.env.TRADING_DESK_SURPLUS_PCT = "50";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TRADING_DESK_SURPLUS_FLOOR;
    delete process.env.TRADING_DESK_SURPLUS_PCT;
  });

  it("calculateSurplus includes retirement_memo when surplus > 0", () => {
    const router = new SurplusRouter(tmpDir, mockLogger());
    router.recordVenuePnl("polymarket", 100, 0, 5, 50);

    const surplus = router.calculateSurplus();
    expect(surplus.routed_to_regen_usd).toBe(45);
    expect(surplus.retirement_memo).toContain("regen-market-monitor contributors");
    expect(surplus.retirement_memo).toContain("$45.00");
  });

  it("calculateSurplus has no retirement_memo when below floor", () => {
    const router = new SurplusRouter(tmpDir, mockLogger());
    router.recordVenuePnl("polymarket", 5, 0, 1, 5);

    const surplus = router.calculateSurplus();
    expect(surplus.routed_to_regen_usd).toBe(0);
    expect(surplus.retirement_memo).toBeUndefined();
  });

  it("markRouted returns attribution memo", () => {
    const router = new SurplusRouter(tmpDir, mockLogger());
    router.recordVenuePnl("polymarket", 100, 0, 5, 50);

    const memo = router.markRouted(45);
    expect(memo).toContain("regen-market-monitor contributors");
    expect(memo).toContain("$45.00");
  });

  it("markRouted returns null when no surplus available", () => {
    const router = new SurplusRouter(tmpDir, mockLogger());
    router.recordVenuePnl("polymarket", 5, 0, 1, 5);

    const memo = router.markRouted(10);
    expect(memo).toBeNull();
  });

  it("recordRetirement is accessible through SurplusRouter", () => {
    const router = new SurplusRouter(tmpDir, mockLogger());
    const record = router.recordRetirement({
      timestamp: new Date().toISOString(),
      credits_retired: 20,
      credit_class: "C01",
      batch_denom: "C01-001",
      usd_value: 10.00,
      surplus_source_usd: 10.00,
      tx_hash: "INTEGRATION_TX",
      jurisdiction: "US-CA",
    });

    expect(record.id).toMatch(/^ret-/);
    expect(record.memo).toContain("regen-market-monitor contributors");

    const stats = router.getRetirementStats();
    expect(stats.retirements_count).toBe(1);
    expect(stats.total_retired_credits).toBe(20);
  });

  it("getRetirementStatsResponse includes surplus routing context", () => {
    const router = new SurplusRouter(tmpDir, mockLogger());
    router.recordVenuePnl("polymarket", 100, 0, 5, 50);
    router.markRouted(45);

    router.recordRetirement({
      timestamp: new Date().toISOString(),
      credits_retired: 50,
      credit_class: "C01",
      batch_denom: "C01-001",
      usd_value: 10.00,
      surplus_source_usd: 10.00,
      tx_hash: "FULL_FLOW_TX",
      jurisdiction: "US-CA",
    });

    const resp = router.getRetirementStatsResponse();
    expect(resp.stats.retirements_count).toBe(1);
    expect(resp.surplus_context.cumulative_surplus_routed_usd).toBe(45);
    expect(resp.surplus_context.cumulative_retired_usd).toBe(10.00);
    expect(resp.surplus_context.pending_retirement_usd).toBe(35.00);
  });
});
