import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlertManager } from '../../src/alerts.js';
import { DataStore } from '../../src/data-store.js';
import {
  createMockConfig,
  createMockLogger,
  createMockAnomalyReport,
  createMockLiquidityReport,
  createMockRetirementReport,
} from '../helpers/mocks.js';
import type { MarketAlert } from '../../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('AlertManager', () => {
  let tmpDir: string;
  let store: DataStore;
  let alertManager: AlertManager;
  let firedAlerts: MarketAlert[];
  const logger = createMockLogger();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'rmm-alerts-'));
    const config = createMockConfig({ alertCooldownMs: 60000 });
    store = new DataStore(tmpDir, logger);
    alertManager = new AlertManager(config, store, logger);
    firedAlerts = [];
    alertManager.onAlert((alert) => {
      firedAlerts.push(alert);
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── LOW_STOCK alerts ─────────────────────────────────────────────

  it('fires LOW_STOCK when available_credits < threshold', async () => {
    const report = createMockLiquidityReport({ available_credits: 500 });
    await alertManager.checkLiquidity(report);

    expect(firedAlerts.length).toBeGreaterThanOrEqual(1);
    const lowStock = firedAlerts.find((a) => a.title === 'Low Credit Stock');
    expect(lowStock).toBeDefined();
  });

  it('does not fire LOW_STOCK when at threshold', async () => {
    const report = createMockLiquidityReport({ available_credits: 1000 });
    await alertManager.checkLiquidity(report);

    const lowStock = firedAlerts.find((a) => a.title === 'Low Credit Stock');
    expect(lowStock).toBeUndefined();
  });

  // ─── PRICE_MOVE alerts ────────────────────────────────────────────

  it('fires PRICE_MOVE when change > 10%', async () => {
    // current=0.05, last=0.04 => 25% change, threshold is 10%
    const report = createMockAnomalyReport('normal', {
      current_price: 0.05,
      z_score: 0.5,
    });
    await alertManager.checkAnomaly(report, 0.04);

    const priceMove = firedAlerts.find((a) => a.title === 'Significant Price Movement');
    expect(priceMove).toBeDefined();
  });

  it('does not fire PRICE_MOVE at 9.9%', async () => {
    // 9.9% change: current = 0.04 * 1.099 = 0.04396
    const report = createMockAnomalyReport('normal', {
      current_price: 0.04396,
      z_score: 0.5,
    });
    await alertManager.checkAnomaly(report, 0.04);

    const priceMove = firedAlerts.find((a) => a.title === 'Significant Price Movement');
    expect(priceMove).toBeUndefined();
  });

  // ─── COMMUNITY_GOAL_COMPLETE alerts ───────────────────────────────

  it('fires COMMUNITY_GOAL_COMPLETE at 100%', async () => {
    const report = createMockRetirementReport({
      completed_goals: [
        { id: 'goal-1', name: 'Test Goal', target: 1000, current: 1000, percent_complete: 100 },
      ],
    });
    await alertManager.checkRetirements(report);

    const goalComplete = firedAlerts.find((a) => a.title === 'Community Goal Completed');
    expect(goalComplete).toBeDefined();
  });

  it('does not fire COMMUNITY_GOAL_COMPLETE at 99%', async () => {
    const report = createMockRetirementReport({
      completed_goals: [],
      goals: [
        { id: 'goal-1', name: 'Test Goal', target: 1000, current: 990, percent_complete: 99 },
      ],
    });
    await alertManager.checkRetirements(report);

    const goalComplete = firedAlerts.find((a) => a.title === 'Community Goal Completed');
    expect(goalComplete).toBeUndefined();
  });

  // ─── Z-score WARNING alerts ───────────────────────────────────────

  it('fires z-score WARNING at 2.0', async () => {
    const report = createMockAnomalyReport('warning', {
      z_score: 2.0,
      current_price: 0.055,
      median_price: 0.042,
    });
    await alertManager.checkAnomaly(report);

    const warning = firedAlerts.find((a) => a.title === 'Price Anomaly Detected');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('WARNING');
  });

  it('does not fire z-score WARNING at 1.99', async () => {
    const report = createMockAnomalyReport('normal', {
      z_score: 1.99,
      current_price: 0.045,
      median_price: 0.042,
    });
    await alertManager.checkAnomaly(report);

    const warning = firedAlerts.find((a) => a.title === 'Price Anomaly Detected');
    expect(warning).toBeUndefined();
  });

  // ─── Z-score CRITICAL alerts ──────────────────────────────────────

  it('fires z-score CRITICAL at 3.5', async () => {
    const report = createMockAnomalyReport('critical', {
      z_score: 3.5,
      current_price: 0.089,
      median_price: 0.042,
    });
    await alertManager.checkAnomaly(report);

    const critical = firedAlerts.find((a) => a.title === 'Price Manipulation Flagged');
    expect(critical).toBeDefined();
    expect(critical!.severity).toBe('CRITICAL');
  });

  it('does not fire z-score CRITICAL at 3.49', async () => {
    const report = createMockAnomalyReport('warning', {
      z_score: 3.49,
      current_price: 0.080,
      median_price: 0.042,
    });
    await alertManager.checkAnomaly(report);

    const critical = firedAlerts.find((a) => a.title === 'Price Manipulation Flagged');
    expect(critical).toBeUndefined();
    // Should still fire the WARNING-level anomaly
    const warning = firedAlerts.find((a) => a.title === 'Price Anomaly Detected');
    expect(warning).toBeDefined();
  });

  // ─── Deduplication ────────────────────────────────────────────────

  it('deduplication: same alert does not re-fire within cooldown', async () => {
    const report = createMockLiquidityReport({ available_credits: 500 });

    await alertManager.checkLiquidity(report);
    await alertManager.checkLiquidity(report);

    const lowStockAlerts = firedAlerts.filter((a) => a.title === 'Low Credit Stock');
    expect(lowStockAlerts).toHaveLength(1);
  });

  it('deduplication: same alert fires after cooldown expires', async () => {
    const config = createMockConfig({ alertCooldownMs: 100 }); // 100ms cooldown
    const shortCooldownManager = new AlertManager(config, store, logger);
    const fired: MarketAlert[] = [];
    shortCooldownManager.onAlert((a) => fired.push(a));

    const report = createMockLiquidityReport({ available_credits: 500 });

    await shortCooldownManager.checkLiquidity(report);
    expect(fired.filter((a) => a.title === 'Low Credit Stock')).toHaveLength(1);

    // Wait past cooldown
    await new Promise((r) => setTimeout(r, 150));

    await shortCooldownManager.checkLiquidity(report);
    expect(fired.filter((a) => a.title === 'Low Credit Stock')).toHaveLength(2);
  });

  // ─── Independence ─────────────────────────────────────────────────

  it('different alert types fire independently', async () => {
    const liquidityReport = createMockLiquidityReport({ available_credits: 500 });
    const anomalyReport = createMockAnomalyReport('normal', {
      current_price: 0.05,
      z_score: 0.5,
    });

    await alertManager.checkLiquidity(liquidityReport);
    await alertManager.checkAnomaly(anomalyReport, 0.04); // 25% price move

    const lowStock = firedAlerts.find((a) => a.title === 'Low Credit Stock');
    const priceMove = firedAlerts.find((a) => a.title === 'Significant Price Movement');
    expect(lowStock).toBeDefined();
    expect(priceMove).toBeDefined();
  });

  // ─── Severity checks ─────────────────────────────────────────────

  it('severity: LOW_STOCK is WARNING', async () => {
    const report = createMockLiquidityReport({ available_credits: 500 });
    await alertManager.checkLiquidity(report);

    const lowStock = firedAlerts.find((a) => a.title === 'Low Credit Stock');
    expect(lowStock).toBeDefined();
    expect(lowStock!.severity).toBe('WARNING');
  });

  it('severity: z-score >= 3.5 is CRITICAL', async () => {
    const report = createMockAnomalyReport('critical', {
      z_score: 4.0,
      current_price: 0.089,
      median_price: 0.042,
    });
    await alertManager.checkAnomaly(report);

    const critical = firedAlerts.find((a) => a.title === 'Price Manipulation Flagged');
    expect(critical).toBeDefined();
    expect(critical!.severity).toBe('CRITICAL');
  });
});
