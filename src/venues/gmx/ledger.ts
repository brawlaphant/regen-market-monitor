/**
 * GMX daily trade ledger — persisted to disk.
 */

import fs from "node:fs";
import path from "node:path";
import type { GmxLedger } from "./types.js";

export function loadLedger(dataDir: string): GmxLedger {
  const today = new Date().toISOString().split("T")[0];
  const dir = path.join(dataDir, "gmx");
  const file = path.join(dir, `ledger-${today}.json`);
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8")) as GmxLedger;
      if (data.date === today) return data;
    } catch { /* corrupt, start fresh */ }
  }
  return { date: today, spent_usd: 0, trades: [] };
}

export function saveLedger(dataDir: string, ledger: GmxLedger): void {
  const dir = path.join(dataDir, "gmx");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ledger-${ledger.date}.json`);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, file);
}
