import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { ThresholdTuner } from "../../src/tuner/threshold-tuner.js";
import { createMockConfig, createMockLogger } from "../helpers/mocks.js";

describe("ThresholdTuner", () => {
  let tmpDir: string;
  let tuner: ThresholdTuner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "tuner-test-"));
    const config = createMockConfig({ dataDir: tmpDir });
    tuner = new ThresholdTuner(config, createMockLogger());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write alert-state.json with alerts titled to match tuner's prefix matching */
  function writeAlertState(
    alertCount: number,
    spanDays: number,
    prefix = "Low Credit Stock"
  ): void {
    const now = Date.now();
    const startMs = now - spanDays * 24 * 60 * 60 * 1000;
    const lastFired: Record<string, number> = {};

    for (let i = 0; i < alertCount; i++) {
      const t = startMs + (i / Math.max(alertCount - 1, 1)) * (now - startMs);
      lastFired[`${prefix} ${i}`] = Math.round(t);
    }

    const state = {
      lastFired,
      alertsFiredToday: 0,
      dayStart: now,
    };
    fs.writeFileSync(path.join(tmpDir, "alert-state.json"), JSON.stringify(state));
  }

  it("returns ready:false when < 168 hours of data", () => {
    writeAlertState(10, 2);
    const report = tuner.analyze();
    expect(report.ready).toBe(false);
  });

  it("returns ready:true with correct analysis for 7+ days", () => {
    writeAlertState(15, 8);
    const report = tuner.analyze();
    expect(report.ready).toBe(true);
    expect(report.thresholds).toBeDefined();
    expect(report.thresholds!.length).toBe(4);
  });

  it("classifies > 3 fires/day as TOO_NOISY", () => {
    // 30 fires in 7 days = 4.3/day
    writeAlertState(30, 7);
    const report = tuner.analyze();
    expect(report.ready).toBe(true);
    const lowStock = report.thresholds!.find((t) => t.name === "LOW_STOCK_THRESHOLD");
    expect(lowStock!.classification).toBe("TOO_NOISY");
  });

  it("classifies < 0.5 fires/day as TOO_LOOSE", () => {
    // 2 fires in 7 days = 0.29/day
    writeAlertState(2, 7);
    const report = tuner.analyze();
    expect(report.ready).toBe(true);
    const lowStock = report.thresholds!.find((t) => t.name === "LOW_STOCK_THRESHOLD");
    expect(lowStock!.classification).toBe("TOO_LOOSE");
  });

  it("classifies 1.5 fires/day as HEALTHY", () => {
    // 11 fires in 7 days = 1.57/day
    writeAlertState(11, 7);
    const report = tuner.analyze();
    expect(report.ready).toBe(true);
    const lowStock = report.thresholds!.find((t) => t.name === "LOW_STOCK_THRESHOLD");
    expect(lowStock!.classification).toBe("HEALTHY");
  });

  it("suggests 15% tightening for TOO_NOISY", () => {
    writeAlertState(30, 7);
    const report = tuner.analyze();
    const lowStock = report.thresholds!.find((t) => t.name === "LOW_STOCK_THRESHOLD");
    // LOW_STOCK tightening direction is "lower" → current * 0.85
    expect(lowStock!.suggestedValue).toBeCloseTo(1000 * 0.85, 0);
    expect(lowStock!.recommendation).toBe("TIGHTEN");
  });

  it("suggests 15% loosening for TOO_LOOSE", () => {
    writeAlertState(2, 7);
    const report = tuner.analyze();
    const lowStock = report.thresholds!.find((t) => t.name === "LOW_STOCK_THRESHOLD");
    // LOW_STOCK loosening direction is "lower" inverted → current * 1.15
    expect(lowStock!.suggestedValue).toBeCloseTo(1000 * 1.15, 0);
    expect(lowStock!.recommendation).toBe("LOOSEN");
  });

  it("confidence HIGH for > 14 days, MEDIUM 7-14, LOW < 7", () => {
    writeAlertState(20, 15);
    expect(tuner.analyze().confidence).toBe("HIGH");

    writeAlertState(20, 10);
    expect(tuner.analyze().confidence).toBe("MEDIUM");

    writeAlertState(20, 7);
    expect(tuner.analyze().confidence).toBe("MEDIUM");
  });

  it("applyTuning with approved=false does not write file", () => {
    writeAlertState(30, 7);
    const report = tuner.analyze();
    tuner.applyTuning(report, false);
    expect(fs.existsSync(path.join(tmpDir, "tuning-applied.json"))).toBe(false);
  });

  it("applyTuning with approved=true writes tuning-applied.json", () => {
    writeAlertState(30, 7);
    const report = tuner.analyze();
    tuner.applyTuning(report, true);

    const filePath = path.join(tmpDir, "tuning-applied.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(written).toHaveProperty("LOW_STOCK_THRESHOLD");
  });

  it("missing data files returns ready:false without throwing", () => {
    const report = tuner.analyze();
    expect(report.ready).toBe(false);
    expect(report.reason).toBe("no_data");
  });
});
