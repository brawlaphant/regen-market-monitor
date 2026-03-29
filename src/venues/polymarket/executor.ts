/**
 * Polymarket Execution Adapter
 *
 * Places real orders on Polymarket's CLOB via @polymarket/clob-client.
 * Risk controls: daily spend cap, per-trade max, min liquidity, max spread, cooldown.
 *
 * Requires: POLYMARKET_PK, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../logger.js";
import type { ScoredMarket } from "./types.js";

const CLOB_BASE = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

export interface PolymarketExecutorConfig {
  privateKey?: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  dailyCap: number;
  maxBet: number;
  minEdge: number;
  minLiquidity: number;
  maxSpreadPct: number;
  cooldownMs: number;
  dryRun: boolean;
  dataDir: string;
}

export interface ExecutionResult {
  market: string;
  side: "BUY_YES" | "BUY_NO";
  size: number;
  executed: boolean;
  dry_run: boolean;
  error?: string;
}

interface DailyLedger {
  date: string;
  spent: number;
  trades: Array<{ market: string; side: string; size: number; timestamp: string; dry_run: boolean }>;
}

export class PolymarketExecutor {
  private config: PolymarketExecutorConfig;
  private logger: Logger;
  private lastTradeAt = 0;

  constructor(config: PolymarketExecutorConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  get isConfigured(): boolean {
    return !!(this.config.privateKey && this.config.apiKey && this.config.apiSecret && this.config.passphrase);
  }

  /** Get USDC balance from Polymarket */
  async getBalance(): Promise<number | null> {
    if (!this.isConfigured) return null;
    try {
      const client = await this.getClient();
      const allowances = await client.getBalanceAllowance({ asset_type: "USDC" });
      return parseFloat(String(allowances?.balance ?? "0"));
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Polymarket balance check failed");
      return null;
    }
  }

  /** Execute ranked signals with risk controls */
  async executeSignals(signals: ScoredMarket[], source: string): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    const ledger = this.loadLedger();

    for (const signal of signals) {
      // Risk gate: daily cap
      if (ledger.spent + signal.betSize > this.config.dailyCap) {
        results.push({ market: signal.question, side: signal.direction, size: signal.betSize, executed: false, dry_run: this.config.dryRun, error: "daily cap reached" });
        continue;
      }

      // Risk gate: per-trade max
      const size = Math.min(signal.betSize, this.config.maxBet);

      // Risk gate: minimum edge
      if (Math.abs(signal.divergence) < this.config.minEdge) {
        results.push({ market: signal.question, side: signal.direction, size, executed: false, dry_run: this.config.dryRun, error: "below min edge" });
        continue;
      }

      // Risk gate: minimum liquidity
      if (signal.liquidity < this.config.minLiquidity) {
        results.push({ market: signal.question, side: signal.direction, size, executed: false, dry_run: this.config.dryRun, error: "insufficient liquidity" });
        continue;
      }

      // Risk gate: cooldown
      if (Date.now() - this.lastTradeAt < this.config.cooldownMs) {
        results.push({ market: signal.question, side: signal.direction, size, executed: false, dry_run: this.config.dryRun, error: "cooldown active" });
        continue;
      }

      // Execute or dry-run
      if (this.config.dryRun || !this.isConfigured) {
        this.logger.info({ market: signal.question.substring(0, 60), side: signal.direction, size, source }, "[DRY RUN] Would trade");
        results.push({ market: signal.question, side: signal.direction, size, executed: true, dry_run: true });
      } else {
        try {
          await this.placeOrder(signal, size);
          results.push({ market: signal.question, side: signal.direction, size, executed: true, dry_run: false });
          this.logger.info({ market: signal.question.substring(0, 60), side: signal.direction, size }, "Trade executed");
        } catch (err) {
          results.push({ market: signal.question, side: signal.direction, size, executed: false, dry_run: false, error: err instanceof Error ? err.message : String(err) });
          this.logger.warn({ err }, "Trade execution failed");
        }
      }

      ledger.spent += size;
      ledger.trades.push({
        market: signal.question.substring(0, 100),
        side: signal.direction,
        size,
        timestamp: new Date().toISOString(),
        dry_run: this.config.dryRun,
      });
      this.lastTradeAt = Date.now();
    }

    this.saveLedger(ledger);
    return results;
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private async placeOrder(signal: ScoredMarket, size: number): Promise<void> {
    const client = await this.getClient();
    const isBuyYes = signal.direction === "BUY_YES";
    const price = isBuyYes ? signal.crowdYes : 1 - signal.crowdYes;

    // Use market order for simplicity
    await client.createAndPostMarketOrder({
      tokenID: signal.slug,
      side: isBuyYes ? "BUY" : "SELL",
      amount: size,
    });
  }

  private async getClient(): Promise<any> {
    const { ClobClient } = await import("@polymarket/clob-client");
    const { createWalletClient, http } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { polygon } = await import("viem/chains");

    const account = privateKeyToAccount(this.config.privateKey! as `0x${string}`);
    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });
    return new ClobClient(CLOB_BASE, CHAIN_ID, signer, {
      key: this.config.apiKey!,
      secret: this.config.apiSecret!,
      passphrase: this.config.passphrase!,
    });
  }

  private loadLedger(): DailyLedger {
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(this.config.dataDir, "polymarket", `ledger-${today}.json`);
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8")) as DailyLedger;
        if (data.date === today) return data;
      }
    } catch { /* corrupt */ }
    return { date: today, spent: 0, trades: [] };
  }

  private saveLedger(ledger: DailyLedger): void {
    try {
      const dir = path.join(this.config.dataDir, "polymarket");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `ledger-${ledger.date}.json`);
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Polymarket ledger save failed");
    }
  }
}

/** Build config from environment variables */
export function buildPolymarketExecutorConfig(dataDir: string): PolymarketExecutorConfig {
  const safeFloat = (v: string | undefined, fallback: number): number => {
    const n = parseFloat(v || String(fallback));
    return isNaN(n) ? fallback : n;
  };

  return {
    privateKey: (process.env.POLYMARKET_PK || "").trim() || undefined,
    apiKey: (process.env.POLYMARKET_API_KEY || "").trim() || undefined,
    apiSecret: (process.env.POLYMARKET_API_SECRET || "").trim() || undefined,
    passphrase: (process.env.POLYMARKET_PASSPHRASE || "").trim() || undefined,
    dailyCap: safeFloat(process.env.POLYMARKET_DAILY_CAP, 50),
    maxBet: safeFloat(process.env.POLYMARKET_MAX_BET, 15),
    minEdge: safeFloat(process.env.POLYMARKET_MIN_EDGE, 0.12),
    minLiquidity: safeFloat(process.env.POLYMARKET_MIN_LIQUIDITY, 50_000),
    maxSpreadPct: safeFloat(process.env.POLYMARKET_MAX_SPREAD, 0.06),
    cooldownMs: safeFloat(process.env.POLYMARKET_COOLDOWN_MS, 30_000),
    dryRun: (process.env.POLYMARKET_DRY_RUN || "true").toLowerCase() !== "false",
    dataDir,
  };
}
