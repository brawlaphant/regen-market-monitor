import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadLedger, saveLedger } from "../../src/venues/hyperliquid/ledger.js";

describe("Hyperliquid ledger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "hl-ledger-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates fresh ledger when none exists", () => {
    const ledger = loadLedger(tmpDir);
    expect(ledger.date).toBe(new Date().toISOString().split("T")[0]);
    expect(ledger.spent_usd).toBe(0);
    expect(ledger.trades).toHaveLength(0);
  });

  it("round-trips through save/load", () => {
    const ledger = loadLedger(tmpDir);
    ledger.spent_usd = 42.50;
    ledger.trades.push({
      coin: "ETH",
      direction: "long",
      size_usd: 25,
      price: 3000,
      timestamp: new Date().toISOString(),
      dry_run: true,
    });

    saveLedger(tmpDir, ledger);

    const loaded = loadLedger(tmpDir);
    expect(loaded.spent_usd).toBe(42.50);
    expect(loaded.trades).toHaveLength(1);
    expect(loaded.trades[0].coin).toBe("ETH");
  });

  it("creates directory if missing", () => {
    const nested = path.join(tmpDir, "deep", "nested");
    // saveLedger creates the hyperliquid/ subdirectory
    const ledger = { date: "2026-03-28", spent_usd: 0, trades: [] };
    // This would fail without mkdir in saveLedger
    saveLedger(tmpDir, ledger);
    const file = path.join(tmpDir, "hyperliquid", `ledger-2026-03-28.json`);
    expect(fs.existsSync(file)).toBe(true);
  });
});
