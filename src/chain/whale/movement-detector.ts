import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../logger.js";
import type { WatchedWallet } from "./wallet-registry.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MovementType =
  | "send"
  | "receive"
  | "lp_add"
  | "lp_remove"
  | "bridge_out"
  | "bridge_in"
  | "stake"
  | "unstake";

export type Significance = "low" | "medium" | "high" | "critical";

export interface WalletMovement {
  id: string;
  wallet_address: string;
  wallet_label: string;
  wallet_tier: string;
  chain: string;
  movement_type: MovementType;
  amount_regen: number;
  amount_usd: number;
  tx_hash: string;
  block_height: number;
  timestamp: string; // ISO
  counterparty_address?: string;
  counterparty_label?: string;
  significance: Significance;
}

// ─── Thresholds from env ──────────────────────────────────────────────────────

const CRITICAL_THRESHOLD = parseFloat(process.env.WHALE_CRITICAL_THRESHOLD_REGEN || "500000");
const HIGH_THRESHOLD = parseFloat(process.env.WHALE_HIGH_THRESHOLD_REGEN || "100000");
const MEDIUM_THRESHOLD = parseFloat(process.env.WHALE_MEDIUM_THRESHOLD_REGEN || "10000");

const REGEN_PRICE_USD = parseFloat(process.env.REGEN_PRICE_USD || "0.03");
const REGEN_DENOM = "uregen";
const REGEN_DECIMALS = 6;

const LCD_ENDPOINTS: Record<string, string> = {
  regen: process.env.REGEN_LCD_URL || "https://regen.api.boz.moe",
  osmosis: process.env.OSMOSIS_LCD_URL || "https://lcd.osmosis.zone",
};

const RING_BUFFER_MAX = 500;

// ─── MovementDetector ─────────────────────────────────────────────────────────

export class MovementDetector {
  private logger: Logger;
  private movementsFilePath: string;
  private ringBuffer: WalletMovement[] = [];
  /** Previous balances for delta detection, keyed by address */
  private previousBalances: Map<string, number> = new Map();

  constructor(logger: Logger, dataDir: string = "./data") {
    this.logger = logger;
    this.movementsFilePath = join(dataDir, "whale-movements.jsonl");
    this.loadRingBufferFromDisk();
  }

  // ─── Public API ─────────────────────────────────────────────────────

  async poll(wallets: WatchedWallet[]): Promise<WalletMovement[]> {
    const detected: WalletMovement[] = [];

    for (const wallet of wallets) {
      try {
        const currentBalance = await this.queryBalance(wallet.address, wallet.chain);
        const previousBalance = this.previousBalances.get(wallet.address);

        // First poll — record baseline, no movement
        if (previousBalance === undefined) {
          this.previousBalances.set(wallet.address, currentBalance);
          continue;
        }

        const delta = currentBalance - previousBalance;
        if (Math.abs(delta) < 1) {
          // No meaningful change
          this.previousBalances.set(wallet.address, currentBalance);
          continue;
        }

        const amountRegen = Math.abs(delta);
        const amountUsd = amountRegen * REGEN_PRICE_USD;
        const movementType: MovementType = delta > 0 ? "receive" : "send";

        const movement: WalletMovement = {
          id: randomUUID(),
          wallet_address: wallet.address,
          wallet_label: wallet.label,
          wallet_tier: wallet.tier,
          chain: wallet.chain,
          movement_type: movementType,
          amount_regen: amountRegen,
          amount_usd: amountUsd,
          tx_hash: "", // Balance-delta detection cannot resolve tx hash
          block_height: 0,
          timestamp: new Date().toISOString(),
          significance: this.classifySignificance(amountRegen),
        };

        detected.push(movement);
        this.pushToRingBuffer(movement);
        this.appendToDisk(movement);

        this.logger.info(
          {
            address: wallet.address,
            label: wallet.label,
            type: movementType,
            amount: amountRegen,
            significance: movement.significance,
          },
          "Whale movement detected"
        );

        this.previousBalances.set(wallet.address, currentBalance);
      } catch (err) {
        this.logger.warn(
          { address: wallet.address, error: (err as Error).message },
          "Failed to poll wallet for movements"
        );
      }
    }

    if (detected.length > 0) {
      this.logger.info({ count: detected.length }, "Whale movements detected this poll cycle");
    }

    return detected;
  }

  getRecentMovements(limit?: number): WalletMovement[] {
    if (limit === undefined) return [...this.ringBuffer];
    return this.ringBuffer.slice(-limit);
  }

  getRecent(limit = 50, significance?: string): WalletMovement[] {
    let results = [...this.ringBuffer].reverse();
    if (significance) results = results.filter((m) => m.significance === significance);
    return results.slice(0, limit);
  }

  classifySignificance(amountRegen: number): Significance {
    if (amountRegen >= CRITICAL_THRESHOLD) return "critical";
    if (amountRegen >= HIGH_THRESHOLD) return "high";
    if (amountRegen >= MEDIUM_THRESHOLD) return "medium";
    return "low";
  }

  // ─── Ring buffer ────────────────────────────────────────────────────

  private pushToRingBuffer(movement: WalletMovement): void {
    this.ringBuffer.push(movement);
    if (this.ringBuffer.length > RING_BUFFER_MAX) {
      this.ringBuffer.shift();
    }
  }

  // ─── Disk persistence (append-only JSONL) ───────────────────────────

  private appendToDisk(movement: WalletMovement): void {
    try {
      const dir = dirname(this.movementsFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(this.movementsFilePath, JSON.stringify(movement) + "\n", "utf-8");
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message },
        "Failed to append movement to disk"
      );
    }
  }

  private loadRingBufferFromDisk(): void {
    try {
      if (!existsSync(this.movementsFilePath)) return;

      const raw = readFileSync(this.movementsFilePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);

      // Load only the last RING_BUFFER_MAX entries
      const start = Math.max(0, lines.length - RING_BUFFER_MAX);
      for (let i = start; i < lines.length; i++) {
        try {
          const movement = JSON.parse(lines[i]) as WalletMovement;
          this.ringBuffer.push(movement);
        } catch {
          // Skip malformed lines
        }
      }

      this.logger.info(
        { loaded: this.ringBuffer.length, totalOnDisk: lines.length },
        "Loaded movement history from disk"
      );
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message },
        "Failed to load movement history"
      );
    }
  }

  // ─── LCD balance query ──────────────────────────────────────────────

  private async queryBalance(address: string, chain: string): Promise<number> {
    if (chain === "base") {
      // Base chain (EVM) — not implemented via LCD
      return 0;
    }

    const lcdBase = LCD_ENDPOINTS[chain];
    if (!lcdBase) {
      throw new Error(`No LCD endpoint for chain: ${chain}`);
    }

    const url = `${lcdBase}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${REGEN_DENOM}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LCD balance query failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as { balance?: { denom?: string; amount?: string } };
    const rawAmount = json.balance?.amount ?? "0";
    return parseInt(rawAmount, 10) / Math.pow(10, REGEN_DECIMALS);
  }
}
