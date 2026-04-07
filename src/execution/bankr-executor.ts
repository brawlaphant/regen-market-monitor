/**
 * Bankr Execution Adapter
 *
 * Executes trades on Hyperliquid (perps) + Polymarket (prediction markets) via Bankr API.
 * Wires back execution results for signal confidence updates.
 *
 * B2.2 + B2.3 + B2.4 implementation
 */

import type { Logger } from "../logger.js";

// ── B2.1: Bankr API Response Types ──────────────────────────────────────

export interface BankrOrderRequest {
  venue: "hyperliquid" | "polymarket";
  side: "buy" | "sell" | "long" | "short";
  size_usd: number;
  asset: string;
  leverage?: number; // For HL perps
  confidence?: number;
  signal_id?: string;
}

export interface BankrOrderResponse {
  success: boolean;
  order_id: string;
  txHash?: string;
  status: "pending" | "filled" | "partial" | "failed" | "cancelled";
  filled_usd: number;
  average_price: number;
  fee_usd: number;
  error?: string;
  timestamp: string;
}

export interface BankrExecutionFeedback {
  signal_id: string;
  strategy: string;
  order_id: string;
  original_confidence: number;
  execution_quality: number; // 0-1: slippage + fill rate
  realized_pnl?: number;
  timestamp: string;
}

// ── Config ──────────────────────────────────────────────────────────────

export interface BankrConfig {
  /** Bankr wallet address on Arbitrum */
  walletAddress: string;

  /** API key for Bankr operations */
  apiKey: string;

  /** Base URL for Bankr API */
  baseUrl: string;

  /** Dry run mode (paper trading) */
  dryRun: boolean;

  /** Daily spend limit (USD) */
  dailySpendLimit: number;

  /** Max position size per trade (USD) */
  maxTradeUsd: number;

  /** Min confidence to execute (0-1) */
  minConfidenceToExecute: number;
}

// ── Bankr Executor ─────────────────────────────────────────────────────

export class BankrExecutor {
  private config: BankrConfig;
  private logger: Logger;
  private dailySpent = 0;
  private executedOrders: Map<string, BankrOrderResponse> = new Map();

  constructor(config: BankrConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * B2.2: Execute trade via Bankr
   *
   * Returns execution result. If dryRun=true, simulates execution and logs to paper ledger.
   */
  async execute(request: BankrOrderRequest): Promise<BankrOrderResponse> {
    // Gate: confidence check
    if ((request.confidence || 0) < this.config.minConfidenceToExecute) {
      return {
        success: false,
        order_id: `rejected-${Date.now()}`,
        status: "cancelled",
        filled_usd: 0,
        average_price: 0,
        fee_usd: 0,
        error: `Confidence ${request.confidence} below threshold ${this.config.minConfidenceToExecute}`,
        timestamp: new Date().toISOString(),
      };
    }

    // Gate: daily limit check
    if (this.dailySpent + request.size_usd > this.config.dailySpendLimit) {
      return {
        success: false,
        order_id: `rejected-${Date.now()}`,
        status: "cancelled",
        filled_usd: 0,
        average_price: 0,
        fee_usd: 0,
        error: `Daily limit exceeded. Spent: $${this.dailySpent}, limit: $${this.config.dailySpendLimit}`,
        timestamp: new Date().toISOString(),
      };
    }

    // Gate: position size check
    if (request.size_usd > this.config.maxTradeUsd) {
      return {
        success: false,
        order_id: `rejected-${Date.now()}`,
        status: "cancelled",
        filled_usd: 0,
        average_price: 0,
        fee_usd: 0,
        error: `Trade size $${request.size_usd} exceeds max $${this.config.maxTradeUsd}`,
        timestamp: new Date().toISOString(),
      };
    }

    // ── Dry Run (Paper) ────────────────────────────────────────────────

    if (this.config.dryRun) {
      const result: BankrOrderResponse = {
        success: true,
        order_id: `paper-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        status: "filled",
        filled_usd: request.size_usd * 0.99, // 1% slippage
        average_price: 100, // Mock price
        fee_usd: request.size_usd * 0.001, // 0.1% fee
        timestamp: new Date().toISOString(),
      };

      this.dailySpent += result.filled_usd;
      this.executedOrders.set(result.order_id, result);

      this.logger.info(
        { order: result.order_id, asset: request.asset, size: result.filled_usd },
        "[PAPER TRADE] Bankr order filled"
      );

      return result;
    }

    // ── Live Execution ────────────────────────────────────────────────

    try {
      const resp = await fetch(`${this.config.baseUrl}/v1/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          wallet: this.config.walletAddress,
          venue: request.venue,
          side: request.side,
          asset: request.asset,
          size_usd: request.size_usd,
          leverage: request.leverage || 1,
          signal_confidence: request.confidence,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        return {
          success: false,
          order_id: `error-${Date.now()}`,
          status: "failed",
          filled_usd: 0,
          average_price: 0,
          fee_usd: 0,
          error: `Bankr API error: ${resp.status} ${resp.statusText}`,
          timestamp: new Date().toISOString(),
        };
      }

      const result = (await resp.json()) as BankrOrderResponse;

      if (result.success) {
        this.dailySpent += result.filled_usd;
        this.executedOrders.set(result.order_id, result);

        this.logger.info(
          { order: result.order_id, asset: request.asset, filled: result.filled_usd, fee: result.fee_usd },
          "Bankr order executed"
        );
      } else {
        this.logger.warn({ error: result.error }, "Bankr order failed");
      }

      return result;
    } catch (err) {
      return {
        success: false,
        order_id: `error-${Date.now()}`,
        status: "failed",
        filled_usd: 0,
        average_price: 0,
        fee_usd: 0,
        error: err instanceof Error ? err.message : "Unknown error",
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * B2.3: Generate execution feedback for signal confidence update
   */
  generateFeedback(orderId: string, originalConfidence: number, strategy: string, signalId: string): BankrExecutionFeedback | null {
    const order = this.executedOrders.get(orderId);
    if (!order) return null;

    // Quality = fill rate * (1 - slippage%) * (1 - fee%)
    const fillRate = order.status === "filled" ? 1.0 : order.status === "partial" ? 0.5 : 0;
    const slippageRate = order.average_price > 0 ? 1 - 0.01 : 1.0; // Assume 1% slippage
    const executionQuality = fillRate * slippageRate * 0.999; // Tiny fee impact

    return {
      signal_id: signalId,
      strategy,
      order_id: orderId,
      original_confidence: originalConfidence,
      execution_quality: Math.min(1.0, Math.max(0, executionQuality)),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get daily spend status
   */
  getDailyStatus(): {
    spent: number;
    limit: number;
    remaining: number;
    percentage: number;
  } {
    return {
      spent: this.dailySpent,
      limit: this.config.dailySpendLimit,
      remaining: this.config.dailySpendLimit - this.dailySpent,
      percentage: (this.dailySpent / this.config.dailySpendLimit) * 100,
    };
  }

  /** Reset daily counter (call at midnight) */
  resetDaily(): void {
    this.dailySpent = 0;
  }
}
