import fs from "node:fs";
import path from "node:path";
import type { PersistedAlertState, Config } from "../types.js";
import type { Logger } from "../logger.js";

export interface ThresholdClassification {
  name: string;
  currentValue: number;
  firesPerDay: number;
  totalFires: number;
  classification: "TOO_NOISY" | "HEALTHY" | "TOO_LOOSE";
  recommendation: "TIGHTEN" | "MAINTAIN" | "LOOSEN";
  suggestedValue: number;
}

export interface TuningReport {
  ready: boolean;
  reason?: string;
  analysisWindowDays?: number;
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  thresholds?: ThresholdClassification[];
  generatedAt?: string;
}

const MIN_HOURS = 168; // 7 days

/**
 * Self-tuning threshold analyzer.
 * After 7+ days of alert history, suggests better thresholds based on alert frequency.
 * Never auto-applies — always requires explicit applyTuning(report, true) call.
 */
export class ThresholdTuner {
  private config: Config;
  private dataDir: string;
  private logger: Logger;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.dataDir = config.dataDir;
    this.logger = logger;
  }

  analyze(): TuningReport {
    const alertState = this.loadAlertState();
    if (!alertState) {
      return { ready: false, reason: "no_data" };
    }

    const entries = Object.entries(alertState.lastFired);
    if (entries.length === 0) {
      return { ready: false, reason: "no_data" };
    }

    // Determine analysis window from earliest to latest alert
    const timestamps = entries.map(([, ts]) => ts);
    const earliest = Math.min(...timestamps);
    const latest = Math.max(...timestamps, Date.now());
    const windowMs = latest - earliest;
    const windowHours = windowMs / (1000 * 60 * 60);
    const windowDays = windowHours / 24;

    if (windowHours < MIN_HOURS) {
      return {
        ready: false,
        reason: `insufficient_data: ${windowHours.toFixed(0)}h collected, ${MIN_HOURS}h required`,
      };
    }

    const confidence = windowDays > 14 ? "HIGH" : windowDays >= 7 ? "MEDIUM" : "LOW";

    // Count fires per alert type
    const typeCounts: Record<string, number> = {};
    for (const [title] of entries) {
      typeCounts[title] = (typeCounts[title] || 0) + 1;
    }

    // Analyze each configurable threshold
    const thresholds: ThresholdClassification[] = [
      this.analyzeThreshold(
        "LOW_STOCK_THRESHOLD",
        this.config.lowStockThreshold,
        this.countByPrefix(typeCounts, "Low Credit Stock"),
        windowDays,
        "lower" // lowering the threshold makes it tighter (fires less)
      ),
      this.analyzeThreshold(
        "PRICE_MOVE_THRESHOLD",
        this.config.priceMoveThreshold,
        this.countByPrefix(typeCounts, "Significant Price Movement"),
        windowDays,
        "higher" // raising the threshold makes it tighter (fires less)
      ),
      this.analyzeThreshold(
        "Z_SCORE_WARNING",
        2.0,
        this.countByPrefix(typeCounts, "Price Anomaly Detected"),
        windowDays,
        "higher"
      ),
      this.analyzeThreshold(
        "Z_SCORE_CRITICAL",
        3.5,
        this.countByPrefix(typeCounts, "Price Manipulation Flagged"),
        windowDays,
        "higher"
      ),
    ];

    return {
      ready: true,
      analysisWindowDays: Math.round(windowDays * 10) / 10,
      confidence,
      thresholds,
      generatedAt: new Date().toISOString(),
    };
  }

  buildTuningReport(report: TuningReport): string {
    if (!report.ready || !report.thresholds) {
      return `# Threshold Tuning Report\n\nNot ready: ${report.reason}`;
    }

    const rows = report.thresholds
      .map(
        (t) =>
          `| ${t.name} | ${fmtNum(t.currentValue)} | ${fmtNum(t.suggestedValue)} | ${t.firesPerDay.toFixed(1)}/day | ${t.classification} | ${t.recommendation} |`
      )
      .join("\n");

    return [
      `# Threshold Tuning Report`,
      ``,
      `Generated: ${report.generatedAt}`,
      `Analysis window: ${report.analysisWindowDays} days`,
      `Confidence: ${report.confidence}`,
      ``,
      `| Threshold | Current | Suggested | Rate | Status | Action |`,
      `|---|---|---|---|---|---|`,
      rows,
      ``,
      `> **Disclaimer:** These are suggestions only. Review before applying.`,
    ].join("\n");
  }

  applyTuning(report: TuningReport, approved: boolean): void {
    if (!approved || !report.thresholds) return;

    const tuning: Record<string, number> = {};
    for (const t of report.thresholds) {
      tuning[t.name] = t.suggestedValue;
    }

    const filePath = path.join(this.dataDir, "tuning-applied.json");
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(tuning, null, 2), "utf-8");
    this.logger.info({ tuning }, "Tuning applied");
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private analyzeThreshold(
    name: string,
    currentValue: number,
    totalFires: number,
    windowDays: number,
    tightenDirection: "higher" | "lower"
  ): ThresholdClassification {
    const firesPerDay = totalFires / windowDays;

    let classification: ThresholdClassification["classification"];
    let recommendation: ThresholdClassification["recommendation"];
    let suggestedValue: number;

    if (firesPerDay > 3) {
      classification = "TOO_NOISY";
      recommendation = "TIGHTEN";
      suggestedValue =
        tightenDirection === "higher"
          ? currentValue * 1.15
          : currentValue * 0.85;
    } else if (firesPerDay < 0.5) {
      classification = "TOO_LOOSE";
      recommendation = "LOOSEN";
      suggestedValue =
        tightenDirection === "higher"
          ? currentValue * 0.85
          : currentValue * 1.15;
    } else {
      classification = "HEALTHY";
      recommendation = "MAINTAIN";
      suggestedValue = currentValue;
    }

    return {
      name,
      currentValue,
      firesPerDay: Math.round(firesPerDay * 100) / 100,
      totalFires,
      classification,
      recommendation,
      suggestedValue: Math.round(suggestedValue * 10000) / 10000,
    };
  }

  private countByPrefix(counts: Record<string, number>, prefix: string): number {
    let total = 0;
    for (const [key, count] of Object.entries(counts)) {
      if (key.startsWith(prefix)) total += count;
    }
    return total;
  }

  private loadAlertState(): PersistedAlertState | null {
    try {
      const filePath = path.join(this.dataDir, "alert-state.json");
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as PersistedAlertState;
    } catch {
      return null;
    }
  }
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4);
}
