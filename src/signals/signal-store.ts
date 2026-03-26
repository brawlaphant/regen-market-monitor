import fs from "node:fs";
import path from "node:path";
import type { MarketSignal, SignalType } from "./signal-schema.js";
import type { Logger } from "../logger.js";

const DEFAULT_STORE_SIZE = 500;

/**
 * In-memory ring buffer backed by an append-only JSONL file.
 * Always serves from memory — never reads the full file on request.
 */
export class SignalStore {
  private buffer: MarketSignal[] = [];
  private maxSize: number;
  private filePath: string;
  private logger: Logger;
  private signalsToday = 0;
  private todayStart = startOfDayMs();

  constructor(dataDir: string, logger: Logger, maxSize?: number) {
    this.maxSize = maxSize ?? parseInt(process.env.SIGNAL_STORE_SIZE || String(DEFAULT_STORE_SIZE), 10);
    this.filePath = path.join(dataDir, "signals.jsonl");
    this.logger = logger;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.loadFromDisk();
  }

  store(signal: MarketSignal): void {
    this.buffer.push(signal);
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }

    // Track daily count
    const now = startOfDayMs();
    if (now !== this.todayStart) { this.signalsToday = 0; this.todayStart = now; }
    this.signalsToday++;

    // Append to disk
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(signal) + "\n", "utf-8");
    } catch (err) {
      this.logger.error({ err }, "Failed to append signal to disk");
    }
  }

  getRecent(limit = 50, filters?: {
    signal_type?: string;
    severity?: string;
    agent_id?: string;
    since?: string;
  }): MarketSignal[] {
    let results = [...this.buffer].reverse();

    if (filters?.signal_type) {
      results = results.filter((s) => s.signal_type === filters.signal_type);
    }
    if (filters?.severity) {
      results = results.filter((s) => s.severity === filters.severity);
    }
    if (filters?.agent_id) {
      results = results.filter((s) =>
        s.routing.target_agents.includes(filters.agent_id as any)
      );
    }
    if (filters?.since) {
      const since = new Date(filters.since).getTime();
      results = results.filter((s) => new Date(s.timestamp).getTime() > since);
    }

    return results.slice(0, Math.min(limit, 200));
  }

  getById(id: string): MarketSignal | undefined {
    return this.buffer.find((s) => s.id === id);
  }

  getByType(type: SignalType, limit = 50): MarketSignal[] {
    return [...this.buffer]
      .reverse()
      .filter((s) => s.signal_type === type)
      .slice(0, limit);
  }

  count(): {
    total: number;
    by_type: Record<string, number>;
    by_severity: Record<string, number>;
  } {
    const by_type: Record<string, number> = {};
    const by_severity: Record<string, number> = {};
    for (const s of this.buffer) {
      by_type[s.signal_type] = (by_type[s.signal_type] || 0) + 1;
      by_severity[s.severity] = (by_severity[s.severity] || 0) + 1;
    }
    return { total: this.buffer.length, by_type, by_severity };
  }

  get signalsPublishedToday(): number {
    const now = startOfDayMs();
    if (now !== this.todayStart) { this.signalsToday = 0; this.todayStart = now; }
    return this.signalsToday;
  }

  get lastSignalAt(): string | null {
    if (this.buffer.length === 0) return null;
    return this.buffer[this.buffer.length - 1].timestamp;
  }

  get oldest(): string | null {
    if (this.buffer.length === 0) return null;
    return this.buffer[0].timestamp;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const content = fs.readFileSync(this.filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      // Load only last maxSize lines
      const recent = lines.slice(-this.maxSize);
      for (const line of recent) {
        try {
          const signal = JSON.parse(line) as MarketSignal;
          if (signal.version !== "1.0") {
            this.logger.warn({ version: signal.version }, "Skipping signal with unsupported version");
            continue;
          }
          this.buffer.push(signal);
        } catch {
          this.logger.warn("Skipping corrupted signal line in signals.jsonl");
        }
      }

      this.logger.info({ loaded: this.buffer.length }, "Signals loaded from disk");
    } catch (err) {
      this.logger.warn({ err }, "Failed to load signals from disk");
    }
  }
}

function startOfDayMs(): number {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
}
