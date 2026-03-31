/**
 * Retirement Attribution
 *
 * When trading surplus retires ecological credits on Regen Network,
 * this module generates the on-chain retirement memo and tracks
 * cumulative retirement stats.
 *
 * The memo attributes the retirement to the project and its contributors,
 * creating a permanent on-chain record linking trading profits to
 * ecological regeneration.
 *
 * State is file-backed so stats survive restarts.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

// ─── Types ─────────────────────────────────────────────────────────

export interface RetirementRecord {
  id: string;
  timestamp: string;
  credits_retired: number;
  credit_class: string;
  batch_denom: string;
  usd_value: number;
  surplus_source_usd: number;
  tx_hash: string;
  memo: string;
  jurisdiction: string;
}

export interface RetirementStats {
  total_retired_credits: number;
  total_usd_value: number;
  retirements_count: number;
  latest_retirement_tx: string | null;
  latest_retirement_at: string | null;
  credit_classes: Record<string, number>;
  attribution_memo: string;
  first_retirement_at: string | null;
  avg_usd_per_retirement: number;
}

/** Shape returned by GET /retirement/stats */
export interface RetirementStatsResponse {
  stats: RetirementStats;
  recent: RetirementRecord[];
  surplus_context: {
    cumulative_surplus_routed_usd: number;
    cumulative_retired_usd: number;
    pending_retirement_usd: number;
  };
}

interface PersistedState {
  records: RetirementRecord[];
  cumulative_retired_credits: number;
  cumulative_usd_value: number;
  cumulative_surplus_used_usd: number;
}

// ─── Constants ─────────────────────────────────────────────────────

const ATTRIBUTION_MEMO =
  "Retired by regen-market-monitor contributors \u2022 Trading profits \u2192 ecological regeneration \u2022 github.com/brawlaphant/regen-market-monitor";

const STATE_FILE = "retirement-attribution.json";
const MAX_RECENT = 100;

// ─── Implementation ────────────────────────────────────────────────

export class RetirementAttribution {
  private logger: Logger;
  private dataDir: string;
  private state: PersistedState;

  constructor(dataDir: string, logger: Logger) {
    this.logger = logger;
    this.dataDir = dataDir;
    this.state = this.loadState();
  }

  /** Generate the on-chain retirement memo for a surplus-funded retirement. */
  generateMemo(opts?: {
    credit_class?: string;
    batch_denom?: string;
    usd_value?: number;
  }): string {
    const parts = [ATTRIBUTION_MEMO];
    if (opts?.credit_class) {
      parts.push(`Credit class: ${opts.credit_class}`);
    }
    if (opts?.batch_denom) {
      parts.push(`Batch: ${opts.batch_denom}`);
    }
    if (opts?.usd_value) {
      parts.push(`Funded: $${opts.usd_value.toFixed(2)} from trading surplus`);
    }
    return parts.join(" | ");
  }

  /** Get the static attribution string (no context). */
  getAttributionMemo(): string {
    return ATTRIBUTION_MEMO;
  }

  /**
   * Record a completed retirement.
   * Called after a successful on-chain retirement tx.
   */
  recordRetirement(record: Omit<RetirementRecord, "id" | "memo">): RetirementRecord {
    const full: RetirementRecord = {
      ...record,
      id: `ret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      memo: this.generateMemo({
        credit_class: record.credit_class,
        batch_denom: record.batch_denom,
        usd_value: record.usd_value,
      }),
    };

    this.state.records.push(full);
    this.state.cumulative_retired_credits += record.credits_retired;
    this.state.cumulative_usd_value += record.usd_value;
    this.state.cumulative_surplus_used_usd += record.surplus_source_usd;

    // Trim old records from memory (keep last MAX_RECENT)
    if (this.state.records.length > MAX_RECENT * 2) {
      this.state.records = this.state.records.slice(-MAX_RECENT);
    }

    this.saveState();

    this.logger.info(
      {
        retirement_id: full.id,
        credits: record.credits_retired,
        usd: record.usd_value,
        tx: record.tx_hash,
        class: record.credit_class,
      },
      "Retirement recorded with attribution"
    );

    return full;
  }

  /** Get cumulative retirement stats. */
  getStats(): RetirementStats {
    const records = this.state.records;
    const latest = records.length > 0 ? records[records.length - 1] : null;
    const first = records.length > 0 ? records[0] : null;

    // Aggregate by credit class
    const classTotals: Record<string, number> = {};
    for (const r of records) {
      classTotals[r.credit_class] = (classTotals[r.credit_class] || 0) + r.credits_retired;
    }

    const count = records.length;

    return {
      total_retired_credits: this.state.cumulative_retired_credits,
      total_usd_value: Math.round(this.state.cumulative_usd_value * 100) / 100,
      retirements_count: count,
      latest_retirement_tx: latest?.tx_hash ?? null,
      latest_retirement_at: latest?.timestamp ?? null,
      credit_classes: classTotals,
      attribution_memo: ATTRIBUTION_MEMO,
      first_retirement_at: first?.timestamp ?? null,
      avg_usd_per_retirement: count > 0
        ? Math.round((this.state.cumulative_usd_value / count) * 100) / 100
        : 0,
    };
  }

  /** Get recent retirement records (most recent first). */
  getRecent(limit = 10): RetirementRecord[] {
    return [...this.state.records].reverse().slice(0, limit);
  }

  /** Get the full response shape for the /retirement/stats endpoint. */
  getStatsResponse(cumulativeSurplusRoutedUsd: number): RetirementStatsResponse {
    const stats = this.getStats();
    return {
      stats,
      recent: this.getRecent(10),
      surplus_context: {
        cumulative_surplus_routed_usd: cumulativeSurplusRoutedUsd,
        cumulative_retired_usd: this.state.cumulative_usd_value,
        pending_retirement_usd: Math.max(
          0,
          cumulativeSurplusRoutedUsd - this.state.cumulative_surplus_used_usd
        ),
      },
    };
  }

  /** Total USD spent on retirements from surplus. */
  get cumulativeSurplusUsedUsd(): number {
    return this.state.cumulative_surplus_used_usd;
  }

  // ─── Persistence ──────────────────────────────────────────────────

  private loadState(): PersistedState {
    const file = path.join(this.dataDir, STATE_FILE);
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, "utf-8")) as PersistedState;
      }
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Corrupt retirement attribution state — starting fresh"
      );
    }
    return {
      records: [],
      cumulative_retired_credits: 0,
      cumulative_usd_value: 0,
      cumulative_surplus_used_usd: 0,
    };
  }

  private saveState(): void {
    try {
      const dir = this.dataDir;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, STATE_FILE);
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Retirement attribution state save failed"
      );
    }
  }
}
