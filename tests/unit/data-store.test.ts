import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DataStore } from "../../src/data-store.js";
import { createMockLogger } from "../helpers/mocks.js";

describe("DataStore", () => {
  let tmpDir: string;
  let store: DataStore;

  function freshStore() {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "ds-test-"));
    store = new DataStore(tmpDir, createMockLogger());
    return store;
  }

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("market snapshot", () => {
    it("returns null when no snapshot exists", () => {
      freshStore();
      expect(store.loadSnapshot()).toBeNull();
    });

    it("saves and loads snapshot", () => {
      freshStore();
      const snap = { lastPollAt: "2024-01-01", pollDurationMs: 100 } as any;
      store.saveSnapshot(snap);
      const loaded = store.loadSnapshot();
      expect(loaded).toEqual(snap);
    });

    it("handles corrupted snapshot", () => {
      freshStore();
      fs.writeFileSync(path.join(tmpDir, "market-snapshot.json"), "not json");
      expect(store.loadSnapshot()).toBeNull();
    });
  });

  describe("alert state", () => {
    it("returns default when no file", () => {
      freshStore();
      const state = store.loadAlertState();
      expect(state.lastFired).toEqual({});
      expect(state.alertsFiredToday).toBe(0);
    });

    it("saves and loads state", () => {
      freshStore();
      const state = { lastFired: { "test": 123 }, alertsFiredToday: 5, dayStart: Date.now() };
      store.saveAlertState(state);
      const loaded = store.loadAlertState();
      expect(loaded.lastFired["test"]).toBe(123);
      expect(loaded.alertsFiredToday).toBe(5);
    });

    it("resets daily counter on day rollover", () => {
      freshStore();
      const yesterday = Date.now() - 2 * 24 * 60 * 60 * 1000;
      const state = { lastFired: {}, alertsFiredToday: 10, dayStart: yesterday };
      store.saveAlertState(state);
      const loaded = store.loadAlertState();
      expect(loaded.alertsFiredToday).toBe(0);
    });

    it("handles corrupted alert state", () => {
      freshStore();
      fs.writeFileSync(path.join(tmpDir, "alert-state.json"), "{bad json");
      const state = store.loadAlertState();
      expect(state.lastFired).toEqual({});
    });
  });

  describe("price history", () => {
    it("returns empty when no file", () => {
      freshStore();
      expect(store.loadPriceHistory()).toEqual([]);
    });

    it("saves and loads history", () => {
      freshStore();
      const history = [{ price_usd: 0.04, timestamp: "2024-01-01" }];
      store.savePriceHistory(history);
      expect(store.loadPriceHistory()).toEqual(history);
    });

    it("trims to 24", () => {
      freshStore();
      const history = Array.from({ length: 30 }, (_, i) => ({
        price_usd: 0.04 + i * 0.001,
        timestamp: `2024-01-${String(i + 1).padStart(2, "0")}`,
      }));
      store.savePriceHistory(history);
      expect(store.loadPriceHistory()).toHaveLength(24);
    });

    it("handles non-array data", () => {
      freshStore();
      fs.writeFileSync(path.join(tmpDir, "price-history.json"), '"not array"');
      expect(store.loadPriceHistory()).toEqual([]);
    });
  });

  describe("waitForWrites", () => {
    it("resolves when no writes pending", async () => {
      freshStore();
      await expect(store.waitForWrites()).resolves.toBeUndefined();
    });
  });

  describe("directory creation", () => {
    it("creates directory if not exists", () => {
      const newDir = path.join(tmpdir(), `ds-new-${Date.now()}`);
      tmpDir = newDir;
      store = new DataStore(newDir, createMockLogger());
      expect(fs.existsSync(newDir)).toBe(true);
    });
  });
});
