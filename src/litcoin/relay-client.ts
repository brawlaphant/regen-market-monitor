/**
 * LITCREDIT Relay Client
 *
 * Every AI inference call goes through the Litcoin relay network.
 * Each call burns LITCREDIT on-chain (1 LC per 1k tokens, enforced by coordinator).
 * Supports wallet auth (preferred) and key auth (fallback).
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import type {
  RelayConfig,
  RelayHealth,
  LitcreditBurn,
  BurnLedger,
} from "./types.js";

export class RelayClient {
  private config: RelayConfig;
  private logger: Logger;
  private dataDir: string;
  private burnLedger: BurnLedger;
  private headers: Record<string, string>;
  private lastHealth: RelayHealth | null = null;
  private relayWarned = false;

  constructor(config: RelayConfig, dataDir: string, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.dataDir = dataDir;
    this.burnLedger = this.loadLedger();

    // Build auth headers — wallet auth preferred, key auth fallback
    this.headers = { "Content-Type": "application/json" };
    if (config.wallet) {
      this.headers["X-Wallet"] = config.wallet;
    } else if (config.apiKey) {
      this.headers["Authorization"] = `Bearer ${config.apiKey}`;
      this.headers["X-Api-Key"] = config.apiKey;
    }
  }

  /**
   * Send a chat completion request through the LITCREDIT relay.
   * Burns LITCREDIT on-chain for every call.
   */
  async chatCompletion(
    messages: Array<{ role: string; content: string }>,
    options: {
      maxTokens?: number;
      temperature?: number;
      purpose?: string;
    } = {}
  ): Promise<string | null> {
    const { maxTokens = 200, temperature = 0.3, purpose = "general" } = options;
    const start = Date.now();

    try {
      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          model: this.config.model,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (!this.relayWarned) {
          this.logger.warn(
            { status: res.status, body: body.substring(0, 100) },
            "LITCREDIT relay error"
          );
          this.relayWarned = true;
        }
        return null;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const content = data.choices?.[0]?.message?.content?.trim() || null;
      const latency = Date.now() - start;

      // Track burn
      if (data.usage) {
        const totalTokens = data.usage.total_tokens || 0;
        const burn: LitcreditBurn = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          model: this.config.model,
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0,
          total_tokens: totalTokens,
          litcredit_cost: totalTokens / 1000,
          purpose,
          relay_latency_ms: latency,
        };
        this.recordBurn(burn);
      }

      this.relayWarned = false;
      return content;
    } catch (err) {
      if (!this.relayWarned) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "LITCREDIT relay connection failed"
        );
        this.relayWarned = true;
      }
      return null;
    }
  }

  /** Check relay health */
  async checkHealth(): Promise<RelayHealth> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/v1$/, "")}/health`, {
        signal: AbortSignal.timeout(5000),
        headers: this.headers,
      });

      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const escrowBalance = typeof data.escrow_balance === "number" ? data.escrow_balance : null;
        this.lastHealth = {
          reachable: true,
          latency_ms: Date.now() - start,
          relay_providers_online: (data.relay_providers_online as number) || 0,
          escrow_sufficient: escrowBalance !== null ? escrowBalance > 10 : true,
          last_check: new Date().toISOString(),
        };
      } else {
        this.lastHealth = {
          reachable: false,
          latency_ms: Date.now() - start,
          relay_providers_online: 0,
          escrow_sufficient: false,
          last_check: new Date().toISOString(),
        };
      }
    } catch {
      this.lastHealth = {
        reachable: false,
        latency_ms: Date.now() - start,
        relay_providers_online: 0,
        escrow_sufficient: false,
        last_check: new Date().toISOString(),
      };
    }
    return this.lastHealth;
  }

  /** Get today's burn stats */
  getBurnStats(): { total_litcredit: number; total_tokens: number; burn_count: number } {
    this.refreshLedger();
    return {
      total_litcredit: this.burnLedger.total_litcredit,
      total_tokens: this.burnLedger.total_tokens,
      burn_count: this.burnLedger.total_burns,
    };
  }

  /** Get the full burn ledger */
  getLedger(): BurnLedger {
    this.refreshLedger();
    return this.burnLedger;
  }

  /** Get last health check result */
  getLastHealth(): RelayHealth | null {
    return this.lastHealth;
  }

  get isConfigured(): boolean {
    return this.config.authMethod !== "none";
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private recordBurn(burn: LitcreditBurn): void {
    this.refreshLedger();
    // Cap burn history to prevent unbounded memory growth within a day
    if (this.burnLedger.burns.length >= 5000) {
      this.burnLedger.burns.shift();
    }
    this.burnLedger.burns.push(burn);
    this.burnLedger.total_burns++;
    this.burnLedger.total_litcredit += burn.litcredit_cost;
    this.burnLedger.total_tokens += burn.total_tokens;
    this.saveLedger();

    this.logger.debug(
      {
        purpose: burn.purpose,
        tokens: burn.total_tokens,
        lc_cost: burn.litcredit_cost.toFixed(2),
        latency: burn.relay_latency_ms,
      },
      "LITCREDIT burn recorded"
    );
  }

  private refreshLedger(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.burnLedger.date !== today) {
      // Save yesterday's ledger and start fresh
      this.saveLedger();
      this.burnLedger = { date: today, total_burns: 0, total_litcredit: 0, total_tokens: 0, burns: [] };
    }
  }

  private loadLedger(): BurnLedger {
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(this.dataDir, "litcoin", `burn-ledger-${today}.json`);
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8")) as BurnLedger;
        if (data.date === today) return data;
      }
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Corrupt burn ledger — starting fresh");
    }
    return { date: today, total_burns: 0, total_litcredit: 0, total_tokens: 0, burns: [] };
  }

  private saveLedger(): void {
    try {
      const dir = path.join(this.dataDir, "litcoin");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `burn-ledger-${this.burnLedger.date}.json`);
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.burnLedger, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Burn ledger save failed");
    }
  }
}
