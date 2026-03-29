import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadLedger, saveLedger } from "../../src/venues/gmx/ledger.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmx-ledger-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GMX ledger", () => {
  it("returns empty ledger for fresh day", () => {
    const ledger = loadLedger(tmpDir);
    expect(ledger.spent_usd).toBe(0);
    expect(ledger.trades).toHaveLength(0);
    expect(ledger.date).toBe(new Date().toISOString().split("T")[0]);
  });

  it("saves and reloads ledger", () => {
    const ledger = loadLedger(tmpDir);
    ledger.spent_usd = 42;
    ledger.trades.push({
      market: "0xm1",
      direction: "long",
      size_usd: 42,
      price: 3000,
      timestamp: new Date().toISOString(),
      dry_run: true,
    });
    saveLedger(tmpDir, ledger);

    const reloaded = loadLedger(tmpDir);
    expect(reloaded.spent_usd).toBe(42);
    expect(reloaded.trades).toHaveLength(1);
    expect(reloaded.trades[0].market).toBe("0xm1");
  });

  it("creates gmx subdirectory if missing", () => {
    const ledger = loadLedger(tmpDir);
    saveLedger(tmpDir, ledger);
    expect(fs.existsSync(path.join(tmpDir, "gmx"))).toBe(true);
  });

  it("ignores corrupt ledger file", () => {
    const dir = path.join(tmpDir, "gmx");
    fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().split("T")[0];
    fs.writeFileSync(path.join(dir, `ledger-${today}.json`), "NOT JSON");

    const ledger = loadLedger(tmpDir);
    expect(ledger.spent_usd).toBe(0);
  });
});
