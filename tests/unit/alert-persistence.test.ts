import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlertManager } from '../../src/alerts.js';
import { DataStore } from '../../src/data-store.js';
import {
  createMockConfig,
  createMockLogger,
  createMockLiquidityReport,
} from '../helpers/mocks.js';
import type { MarketAlert, PersistedAlertState } from '../../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('alert persistence', () => {
  let tmpDir: string;
  const logger = createMockLogger();
  const config = createMockConfig({ alertCooldownMs: 60000 });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'rmm-alertpersist-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves alert state to disk after firing', async () => {
    const store = new DataStore(tmpDir, logger);
    const manager = new AlertManager(config, store, logger);
    manager.onAlert(() => {});

    const report = createMockLiquidityReport({ available_credits: 500 });
    await manager.checkLiquidity(report);

    const statePath = path.join(tmpDir, 'alert-state.json');
    expect(fs.existsSync(statePath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as PersistedAlertState;
    expect(raw.lastFired).toBeDefined();
    expect(raw.lastFired['Low Credit Stock']).toBeTypeOf('number');
    expect(raw.alertsFiredToday).toBeGreaterThanOrEqual(1);
  });

  it('loads alert state from disk on init', () => {
    const statePath = path.join(tmpDir, 'alert-state.json');
    const now = Date.now();
    const dayStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
    ).getTime();

    const state: PersistedAlertState = {
      lastFired: { 'Low Credit Stock': now - 5000 },
      alertsFiredToday: 3,
      dayStart,
    };
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8');

    const store = new DataStore(tmpDir, logger);
    const loaded = store.loadAlertState();

    expect(loaded.lastFired['Low Credit Stock']).toBe(now - 5000);
    expect(loaded.alertsFiredToday).toBe(3);
  });

  it('cooldown survives restart', async () => {
    // Phase 1: fire alert and flush state
    const store1 = new DataStore(tmpDir, logger);
    const manager1 = new AlertManager(config, store1, logger);
    const fired1: MarketAlert[] = [];
    manager1.onAlert((a) => fired1.push(a));

    const report = createMockLiquidityReport({ available_credits: 500 });
    await manager1.checkLiquidity(report);
    expect(fired1).toHaveLength(1);
    manager1.flush();

    // Phase 2: create new AlertManager from same disk state
    const store2 = new DataStore(tmpDir, logger);
    const manager2 = new AlertManager(config, store2, logger);
    const fired2: MarketAlert[] = [];
    manager2.onAlert((a) => fired2.push(a));

    // Same alert should be suppressed — still within cooldown
    await manager2.checkLiquidity(report);
    expect(fired2).toHaveLength(0);
  });

  it('corrupted JSON: initializes with empty state', () => {
    const statePath = path.join(tmpDir, 'alert-state.json');
    fs.writeFileSync(statePath, '{{not valid json!!!', 'utf-8');

    const store = new DataStore(tmpDir, logger);
    const manager = new AlertManager(config, store, logger);

    // Should not throw, should work normally
    expect(manager.alertsFiredToday).toBe(0);
  });

  it('missing file: initializes with empty state', () => {
    // tmpDir exists but has no alert-state.json
    const store = new DataStore(tmpDir, logger);
    const manager = new AlertManager(config, store, logger);

    expect(manager.alertsFiredToday).toBe(0);
  });
});
