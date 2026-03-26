import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DataStore } from '../../src/data-store.js';
import { createMockLogger } from '../helpers/mocks.js';
import type { PriceSnapshot } from '../../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('price history persistence', () => {
  let tmpDir: string;
  let store: DataStore;
  const logger = createMockLogger();

  function makeSnapshot(price: number, hoursAgo: number): PriceSnapshot {
    return {
      price_usd: price,
      timestamp: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'rmm-pricehistory-'));
    store = new DataStore(tmpDir, logger);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends new price point', () => {
    const history: PriceSnapshot[] = [
      makeSnapshot(0.040, 3),
      makeSnapshot(0.041, 2),
      makeSnapshot(0.042, 1),
    ];
    store.savePriceHistory(history);

    const loaded = store.loadPriceHistory();
    expect(loaded).toHaveLength(3);
    expect(loaded[0].price_usd).toBe(0.040);
    expect(loaded[1].price_usd).toBe(0.041);
    expect(loaded[2].price_usd).toBe(0.042);
  });

  it('trims to 24 when exceeding', () => {
    const history: PriceSnapshot[] = Array.from({ length: 30 }, (_, i) =>
      makeSnapshot(0.040 + i * 0.001, 30 - i),
    );
    store.savePriceHistory(history);

    const loaded = store.loadPriceHistory();
    expect(loaded).toHaveLength(24);
    // Should keep the last 24 (most recent)
    expect(loaded[0].price_usd).toBeCloseTo(0.040 + 6 * 0.001, 6);
    expect(loaded[23].price_usd).toBeCloseTo(0.040 + 29 * 0.001, 6);
  });

  it('saves to disk', () => {
    const history: PriceSnapshot[] = [
      makeSnapshot(0.042, 2),
      makeSnapshot(0.043, 1),
    ];
    store.savePriceHistory(history);

    const filePath = path.join(tmpDir, 'price-history.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PriceSnapshot[];
    expect(raw).toHaveLength(2);
    expect(raw[0].price_usd).toBe(0.042);
    expect(raw[1].price_usd).toBe(0.043);
  });

  it('loads from disk on init', () => {
    const filePath = path.join(tmpDir, 'price-history.json');
    const data: PriceSnapshot[] = [
      { price_usd: 0.050, timestamp: new Date().toISOString() },
      { price_usd: 0.051, timestamp: new Date().toISOString() },
    ];
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');

    // Create a new DataStore to trigger load from disk
    const freshStore = new DataStore(tmpDir, logger);
    const loaded = freshStore.loadPriceHistory();

    expect(loaded).toHaveLength(2);
    expect(loaded[0].price_usd).toBe(0.050);
    expect(loaded[1].price_usd).toBe(0.051);
  });

  it('corrupted JSON: empty history', () => {
    const filePath = path.join(tmpDir, 'price-history.json');
    fs.writeFileSync(filePath, '!!!not json at all{{{', 'utf-8');

    const freshStore = new DataStore(tmpDir, logger);
    const loaded = freshStore.loadPriceHistory();

    expect(loaded).toEqual([]);
  });

  it('missing file: empty history', () => {
    // tmpDir exists but no price-history.json
    const loaded = store.loadPriceHistory();
    expect(loaded).toEqual([]);
  });

  it('exactly 24 + 1 = 24 (trims on overflow)', () => {
    // Save exactly 24 points
    const history24: PriceSnapshot[] = Array.from({ length: 24 }, (_, i) =>
      makeSnapshot(0.040 + i * 0.001, 24 - i),
    );
    store.savePriceHistory(history24);
    expect(store.loadPriceHistory()).toHaveLength(24);

    // Now save 25 points (append 1 more)
    const history25 = [...history24, makeSnapshot(0.065, 0)];
    store.savePriceHistory(history25);

    const loaded = store.loadPriceHistory();
    expect(loaded).toHaveLength(24);
    // The oldest point should have been trimmed — last element should be the new one
    expect(loaded[23].price_usd).toBe(0.065);
  });
});
