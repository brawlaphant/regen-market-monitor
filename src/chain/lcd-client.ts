import { z } from "zod";
import {
  LCDSellOrdersResponseSchema,
  LCDBatchesResponseSchema,
  LCDRetirementsResponseSchema,
  LCDAllowedDenomsResponseSchema,
  LCDVotingParamsResponseSchema,
  LCDLatestBlockResponseSchema,
} from "../schemas.js";
import type {
  LCDSellOrder,
  LCDBatch,
  LCDRetirement,
  LCDAllowedDenom,
  LCDVotingParams,
  Config,
} from "../types.js";
import type { Logger } from "../logger.js";

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const LCD_TIMEOUT_MS = 15000;

/**
 * Direct Regen Network LCD (REST API) client.
 * All responses validated through Zod schemas.
 * Retry 3x with exponential backoff on every call.
 */
export class LCDClient {
  private baseUrl: string;
  private logger: Logger;
  private retries: number;

  constructor(config: Config, logger: Logger) {
    this.baseUrl = config.regenLcdUrl.replace(/\/$/, "");
    this.logger = logger;
    this.retries = 3;
  }

  async getEcocreditSellOrders(batchDenom?: string): Promise<LCDSellOrder[]> {
    const params = new URLSearchParams();
    if (batchDenom) params.set("batch_denom", batchDenom);
    params.set("pagination.limit", "100");
    params.set("pagination.reverse", "true");
    const url = `/regen/ecocredit/marketplace/v1/sell-orders?${params}`;

    const data = await this.fetchValidated(url, LCDSellOrdersResponseSchema, "getEcocreditSellOrders");
    return data.sell_orders;
  }

  async getRecentBatches(classId?: string): Promise<LCDBatch[]> {
    const params = new URLSearchParams();
    if (classId) params.set("class_id", classId);
    params.set("pagination.limit", "50");
    params.set("pagination.reverse", "true");
    const url = `/regen/ecocredit/v1/batches?${params}`;

    const data = await this.fetchValidated(url, LCDBatchesResponseSchema, "getRecentBatches");
    return data.batches;
  }

  async getRecentRetirements(): Promise<LCDRetirement[]> {
    const params = new URLSearchParams();
    params.set("pagination.limit", "50");
    params.set("pagination.reverse", "true");
    const url = `/regen/ecocredit/v1/retirements?${params}`;

    const data = await this.fetchValidated(url, LCDRetirementsResponseSchema, "getRecentRetirements");
    return data.retirements;
  }

  async getMarketplaceDenoms(): Promise<LCDAllowedDenom[]> {
    const url = `/regen/ecocredit/marketplace/v1/allowed-denoms`;
    const data = await this.fetchValidated(url, LCDAllowedDenomsResponseSchema, "getMarketplaceDenoms");
    return data.allowed_denoms;
  }

  async getChainParams(): Promise<LCDVotingParams> {
    const url = `/cosmos/gov/v1/params/voting`;
    const data = await this.fetchValidated(url, LCDVotingParamsResponseSchema, "getChainParams");
    return data.params;
  }

  async getLatestBlockHeight(): Promise<string> {
    const url = `/cosmos/base/tendermint/v1beta1/blocks/latest`;
    const data = await this.fetchValidated(url, LCDLatestBlockResponseSchema, "getLatestBlockHeight");
    return data.block.header.height;
  }

  /** Check if specific sell order IDs still exist on chain */
  async sellOrderExists(orderId: string): Promise<boolean> {
    try {
      const orders = await this.getEcocreditSellOrders();
      return orders.some((o) => o.id === orderId);
    } catch {
      return false;
    }
  }

  // ─── Internal fetch with retry + validation ───────────────────────

  private async fetchValidated<T>(
    path: string,
    schema: z.ZodType<T>,
    method: string
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const url = `${this.baseUrl}${path}`;
        this.logger.debug({ method, url, attempt }, "LCD request");

        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(LCD_TIMEOUT_MS),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`LCD ${method} failed (${res.status}): ${body.slice(0, 200)}`);
        }

        const json: unknown = await res.json();
        const result = schema.safeParse(json);

        if (!result.success) {
          this.logger.error(
            { method, error: result.error.message, raw: JSON.stringify(json).slice(0, 500) },
            "LCD schema validation failed"
          );
          throw new Error(`LCD ${method} schema validation failed: ${result.error.message}`);
        }

        return result.data;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          { method, attempt, error: lastError.message, timestamp: new Date().toISOString() },
          `LCD call failed (attempt ${attempt}/${this.retries})`
        );

        if (attempt < this.retries) {
          const delay = RETRY_DELAYS_MS[attempt - 1] ?? 4000;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError!;
  }
}
