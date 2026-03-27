import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface LPPosition {
  pool_address: string;
  regen_amount: number;
  weth_amount: number;
  lp_tokens: number;
  regen_value_usd: number;
  weth_value_usd: number;
  total_value_usd: number;
  entry_regen_price_usd: number;
  entry_timestamp: string;
  fees_earned_usd: number;
  hydx_earned: number;
  hydx_value_usd: number;
  total_yield_usd: number;
  yield_apy_estimate: number;
  impermanent_loss_pct: number;
  net_position_pct: number;
}

/**
 * Tracks the agent's current Hydrex WETH/REGEN LP position.
 * Computes IL using the constant product AMM formula.
 */
export class LPPositionTracker {
  private position: LPPosition | null = null;
  private filePath: string;
  private logger: Logger;

  constructor(dataDir: string, logger: Logger) {
    this.filePath = path.join(dataDir, "lp-position.json");
    this.logger = logger;
    this.loadFromDisk();
  }

  getPosition(): LPPosition | null { return this.position; }

  updatePosition(currentRegenPrice: number, currentWethPrice = 3500): void {
    if (!this.position) return;

    this.position.regen_value_usd = this.position.regen_amount * currentRegenPrice;
    this.position.weth_value_usd = this.position.weth_amount * currentWethPrice;
    this.position.total_value_usd = this.position.regen_value_usd + this.position.weth_value_usd;

    const il = this.computeIL(currentRegenPrice);
    this.position.impermanent_loss_pct = Math.round(il * 10000) / 100;

    const yieldPct = this.position.total_value_usd > 0
      ? (this.position.total_yield_usd / this.position.total_value_usd) * 100 : 0;
    this.position.net_position_pct = Math.round((yieldPct + il * 100) * 100) / 100;

    this.saveToDisk();
  }

  setPosition(pos: LPPosition): void {
    this.position = pos;
    this.saveToDisk();
  }

  clearPosition(): void {
    this.position = null;
    if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
  }

  /**
   * Impermanent loss for 50/50 constant product pool.
   * IL = 2 * sqrt(price_ratio) / (1 + price_ratio) - 1
   * Returns negative number (e.g. -0.05 = 5% loss vs hold)
   */
  computeIL(currentPrice: number): number {
    if (!this.position || this.position.entry_regen_price_usd <= 0) return 0;
    const priceRatio = currentPrice / this.position.entry_regen_price_usd;
    if (priceRatio <= 0) return 0;
    return 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      this.position = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch { this.position = null; }
  }

  private saveToDisk(): void {
    if (!this.position) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.position, null, 2), "utf-8");
    } catch {}
  }
}
