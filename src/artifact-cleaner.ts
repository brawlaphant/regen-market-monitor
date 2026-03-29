/**
 * Artifact Cleaner
 *
 * Removes stale data files older than a configurable retention period.
 * Covers: trading-desk runs, litcoin burn ledgers, hyperliquid ledgers.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./logger.js";

const DEFAULT_RETENTION_DAYS = 30;

/**
 * Remove files older than `retentionDays` from the given directories.
 * Only removes files matching known artifact patterns (*.json, *.jsonl).
 * Never removes .tmp files (in-progress atomic writes).
 */
export function cleanArtifacts(
  dataDir: string,
  logger: Logger,
  retentionDays = DEFAULT_RETENTION_DAYS
): { removed: number; errors: number } {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const subdirs = ["trading-desk", "litcoin", "hyperliquid", "gmx"];
  let removed = 0;
  let errors = 0;

  for (const sub of subdirs) {
    const dir = path.join(dataDir, sub);
    if (!fs.existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      errors++;
      continue;
    }

    for (const entry of entries) {
      // Only clean known artifact patterns
      if (!entry.endsWith(".json") && !entry.endsWith(".jsonl")) continue;
      // Never remove .tmp files (in-progress writes)
      if (entry.endsWith(".tmp")) continue;
      // Keep state files that aren't date-stamped artifacts
      if (entry === "pnl-state.json" || entry === "execution-daily-cap.json") continue;

      const filePath = path.join(dir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch {
        errors++;
      }
    }
  }

  if (removed > 0) {
    logger.info({ removed, errors, retention_days: retentionDays }, "Artifact cleanup complete");
  }

  return { removed, errors };
}
