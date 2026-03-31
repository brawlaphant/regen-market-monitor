/**
 * %%VENUE_NAME%% daily trade ledger — persisted to disk.
 *
 * Pattern: one JSON file per calendar day, stored in <dataDir>/%%venue_key%%/.
 * Atomic writes via tmp+rename prevent corruption on crash.
 *
 * Copy this file as-is. The only thing to change is:
 *   1. The import path for your Ledger type
 *   2. The subdirectory name (replace "%%venue_key%%")
 */

import fs from "node:fs";
import path from "node:path";
import type { %%VENUE_NAME%%Ledger } from "./types.js";

/**
 * Load today's ledger from disk. Returns a fresh empty ledger if
 * the file doesn't exist, is corrupt, or is from a previous day.
 */
export function loadLedger(dataDir: string): %%VENUE_NAME%%Ledger {
  const today = new Date().toISOString().split("T")[0];
  // TODO: Replace "%%venue_key%%" with your venue slug (e.g. "kujira")
  const dir = path.join(dataDir, "%%venue_key%%");
  const file = path.join(dir, `ledger-${today}.json`);
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8")) as %%VENUE_NAME%%Ledger;
      // Date guard: only use if ledger is from today
      if (data.date === today) return data;
    } catch { /* corrupt file, start fresh */ }
  }
  return { date: today, spent_usd: 0, trades: [] };
}

/**
 * Save the ledger to disk. Uses atomic write (write to .tmp, then rename)
 * so a crash mid-write never corrupts the ledger.
 */
export function saveLedger(dataDir: string, ledger: %%VENUE_NAME%%Ledger): void {
  // TODO: Replace "%%venue_key%%" with your venue slug (e.g. "kujira")
  const dir = path.join(dataDir, "%%venue_key%%");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ledger-${ledger.date}.json`);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, file);
}
