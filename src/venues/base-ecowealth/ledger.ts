/**
 * Base EcoWealth Ledger — daily activity tracking
 *
 * Persists daily signal generation and execution metrics.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BaseEcowealthLedger } from "./types.js";

const DATA_DIR = path.join(os.homedir(), "ecowealth", "data", "rmm-base-ecowealth");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getTodayFileName(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(DATA_DIR, `ledger-${today}.json`);
}

export function loadLedger(): BaseEcowealthLedger[] {
  ensureDataDir();
  const file = getTodayFileName();

  if (!existsSync(file)) {
    return [];
  }

  try {
    const data = readFileSync(file, "utf-8");
    return JSON.parse(data) as BaseEcowealthLedger[];
  } catch {
    return [];
  }
}

export function saveLedger(entries: BaseEcowealthLedger[]): void {
  ensureDataDir();
  const file = getTodayFileName();
  writeFileSync(file, JSON.stringify(entries, null, 2));
}

export function recordSignalGeneration(
  signalsGenerated: number,
  pnl24h: number,
  gasSpent24h: number,
  regenBought: number = 0,
  ecocowealthBought: number = 0
): void {
  const entries = loadLedger();
  const today = new Date().toISOString().slice(0, 10);

  entries.push({
    date: today,
    signals_generated: signalsGenerated,
    total_pnl: pnl24h,
    total_gas_spent: gasSpent24h,
    regen_bought: regenBought,
    ecowealth_bought: ecocowealthBought,
    timestamp: new Date().toISOString(),
  });

  saveLedger(entries);
}
