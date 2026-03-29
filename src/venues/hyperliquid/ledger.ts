/**
 * Hyperliquid daily trade ledger — persisted to disk.
 */

import fs from "node:fs";
import path from "node:path";
import type { HyperliquidLedger } from "./types.js";

export function loadLedger(dataDir: string): HyperliquidLedger {
  const today = new Date().toISOString().split("T")[0];
  const dir = path.join(dataDir, "hyperliquid");
  const file = path.join(dir, `ledger-${today}.json`);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as HyperliquidLedger;
    } catch { /* corrupt, start fresh */ }
  }
  return { date: today, spent_usd: 0, trades: [] };
}

export function saveLedger(dataDir: string, ledger: HyperliquidLedger): void {
  const dir = path.join(dataDir, "hyperliquid");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ledger-${ledger.date}.json`);
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2));
}
