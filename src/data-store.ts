import fs from "node:fs";
import path from "node:path";
import type {
  PriceSnapshot,
  PersistedAlertState,
  MarketSnapshot,
} from "./types.js";
import type { Logger } from "./logger.js";

const MAX_PRICE_HISTORY = 24;

/**
 * Persistent data store backed by JSON files in the data directory.
 * Handles price history, alert state, and market snapshots.
 * All writes are atomic (write to .tmp then rename).
 */
export class DataStore {
  private dir: string;
  private logger: Logger;
  private priceHistoryPath: string;
  private alertStatePath: string;
  private snapshotPath: string;
  private writing = false;

  constructor(dataDir: string, logger: Logger) {
    this.dir = dataDir;
    this.logger = logger;
    this.priceHistoryPath = path.join(dataDir, "price-history.json");
    this.alertStatePath = path.join(dataDir, "alert-state.json");
    this.snapshotPath = path.join(dataDir, "market-snapshot.json");
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.logger.info({ dir: this.dir }, "Created data directory");
    }
  }

  // ─── Price History ────────────────────────────────────────────────

  loadPriceHistory(): PriceSnapshot[] {
    try {
      if (!fs.existsSync(this.priceHistoryPath)) return [];
      const raw = fs.readFileSync(this.priceHistoryPath, "utf-8");
      const data = JSON.parse(raw) as PriceSnapshot[];
      if (!Array.isArray(data)) return [];
      return data.slice(-MAX_PRICE_HISTORY);
    } catch (err) {
      this.logger.warn({ err }, "Failed to load price history, starting fresh");
      return [];
    }
  }

  savePriceHistory(history: PriceSnapshot[]): void {
    const trimmed = history.slice(-MAX_PRICE_HISTORY);
    this.atomicWrite(this.priceHistoryPath, JSON.stringify(trimmed, null, 2));
  }

  // ─── Alert State ──────────────────────────────────────────────────

  loadAlertState(): PersistedAlertState {
    const defaultState: PersistedAlertState = {
      lastFired: {},
      alertsFiredToday: 0,
      dayStart: startOfDayMs(),
    };
    try {
      if (!fs.existsSync(this.alertStatePath)) return defaultState;
      const raw = fs.readFileSync(this.alertStatePath, "utf-8");
      const data = JSON.parse(raw) as PersistedAlertState;
      // Reset counter if day rolled over
      if (data.dayStart < startOfDayMs()) {
        data.alertsFiredToday = 0;
        data.dayStart = startOfDayMs();
      }
      return data;
    } catch (err) {
      this.logger.warn({ err }, "Failed to load alert state, starting fresh");
      return defaultState;
    }
  }

  saveAlertState(state: PersistedAlertState): void {
    this.atomicWrite(this.alertStatePath, JSON.stringify(state, null, 2));
  }

  // ─── Market Snapshot ──────────────────────────────────────────────

  loadSnapshot(): MarketSnapshot | null {
    try {
      if (!fs.existsSync(this.snapshotPath)) return null;
      const raw = fs.readFileSync(this.snapshotPath, "utf-8");
      return JSON.parse(raw) as MarketSnapshot;
    } catch (err) {
      this.logger.warn({ err }, "Failed to load market snapshot");
      return null;
    }
  }

  saveSnapshot(snapshot: MarketSnapshot): void {
    this.atomicWrite(this.snapshotPath, JSON.stringify(snapshot, null, 2));
  }

  // ─── Flush all (called on shutdown) ───────────────────────────────

  /** Wait for any in-progress write, then return */
  async waitForWrites(): Promise<void> {
    // Simple spin — writes are sync and fast
    let waits = 0;
    while (this.writing && waits < 50) {
      await new Promise((r) => setTimeout(r, 10));
      waits++;
    }
  }

  // ─── Atomic write helper ──────────────────────────────────────────

  private atomicWrite(filePath: string, content: string): void {
    this.writing = true;
    try {
      const tmp = filePath + ".tmp";
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, filePath);
    } catch (err) {
      this.logger.error({ err, file: filePath }, "Atomic write failed");
    } finally {
      this.writing = false;
    }
  }
}

function startOfDayMs(): number {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).getTime();
}
