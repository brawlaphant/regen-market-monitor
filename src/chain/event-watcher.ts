import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { LCDClient } from "./lcd-client.js";
import type { ChainEvent, EventCursor, Config, LCDSellOrder } from "../types.js";
import type { Logger } from "../logger.js";

/**
 * Polls the LCD for new on-chain events and emits typed events
 * that the scheduler can subscribe to for immediate workflow triggers.
 *
 * Watches for:
 *  - New sell orders → trigger DETECT_PRICE_ANOMALY
 *  - New retirements → trigger ANALYZE_RETIREMENTS
 *  - Large trades (> threshold) → trigger ASSESS_LIQUIDITY
 *
 * Persists a cursor to data/event-cursor.json to avoid reprocessing.
 */
export class EventWatcher extends EventEmitter {
  private lcd: LCDClient;
  private config: Config;
  private logger: Logger;
  private cursorPath: string;
  private cursor: EventCursor;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(lcd: LCDClient, config: Config, logger: Logger) {
    super();
    this.lcd = lcd;
    this.config = config;
    this.logger = logger;
    this.cursorPath = path.join(config.dataDir, "event-cursor.json");
    this.cursor = this.loadCursor();
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info(
      { interval_ms: this.config.eventPollIntervalMs, cursor: this.cursor },
      "EventWatcher starting"
    );

    // Run immediately, then schedule
    await this.poll();

    this.timer = setInterval(async () => {
      if (!this.running) return;
      await this.poll();
    }, this.config.eventPollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.saveCursor();
    this.logger.info("EventWatcher stopped");
  }

  private async poll(): Promise<void> {
    try {
      await this.checkSellOrders();
    } catch (err) {
      this.logger.warn({ err, check: "sell_orders" }, "EventWatcher sell order check failed");
    }

    try {
      await this.checkRetirements();
    } catch (err) {
      this.logger.warn({ err, check: "retirements" }, "EventWatcher retirement check failed");
    }

    this.cursor.lastPollTimestamp = new Date().toISOString();
    this.saveCursor();
  }

  private async checkSellOrders(): Promise<void> {
    const orders = await this.lcd.getEcocreditSellOrders();
    const lastId = this.cursor.lastSellOrderId;

    // Find orders with IDs newer than our cursor
    const newOrders = lastId
      ? orders.filter((o) => BigInt(o.id) > BigInt(lastId))
      : [];

    if (newOrders.length === 0) {
      // On first run with no cursor, just set the cursor
      if (!lastId && orders.length > 0) {
        this.cursor.lastSellOrderId = orders[0].id;
        this.logger.info({ cursor_set: orders[0].id }, "Initial sell order cursor set");
      }
      return;
    }

    // Update cursor to newest
    const maxId = newOrders.reduce(
      (max, o) => (BigInt(o.id) > BigInt(max) ? o.id : max),
      newOrders[0].id
    );
    this.cursor.lastSellOrderId = maxId;

    this.logger.info(
      { new_orders: newOrders.length, latest_id: maxId },
      "New sell orders detected"
    );

    // Emit event for price anomaly detection
    const event: ChainEvent = {
      type: "new_sell_order",
      blockHeight: maxId,
      data: { count: newOrders.length, orderIds: newOrders.map((o) => o.id) },
    };
    this.emit("chain_event", event);

    // Check for large trades
    for (const order of newOrders) {
      if (this.isLargeTrade(order)) {
        const largeEvent: ChainEvent = {
          type: "large_trade",
          blockHeight: order.id,
          data: { orderId: order.id, quantity: order.quantity, askAmount: order.ask_amount },
        };
        this.logger.info(
          { trigger: "event_watcher", event_type: "large_trade", block_height: order.id, reason: "order volume exceeds threshold" },
          "Large trade detected"
        );
        this.emit("chain_event", largeEvent);
      }
    }
  }

  private async checkRetirements(): Promise<void> {
    let retirements;
    try {
      retirements = await this.lcd.getRecentRetirements();
    } catch {
      // The retirements endpoint may not exist on all LCD nodes — gracefully skip
      return;
    }

    if (retirements.length === 0) return;

    const lastHeight = this.cursor.lastRetirementHeight;
    // If we have no cursor, set it and skip (don't process historical)
    if (!lastHeight) {
      this.cursor.lastRetirementHeight = Date.now().toString();
      this.logger.info("Initial retirement cursor set");
      return;
    }

    // Since we can't easily filter by height from the LCD retirement endpoint,
    // we use the poll timestamp as a proxy — if retirements changed since last poll
    const currentHash = retirements.map((r) => `${r.owner}:${r.batch_denom}:${r.amount}`).join("|");
    if (currentHash !== lastHeight) {
      this.cursor.lastRetirementHeight = currentHash;

      const event: ChainEvent = {
        type: "new_retirement",
        blockHeight: "0",
        data: { count: retirements.length },
      };
      this.logger.info(
        { trigger: "event_watcher", event_type: "new_retirement", block_height: "0", reason: "retirement state changed" },
        "New retirements detected"
      );
      this.emit("chain_event", event);
    }
  }

  private isLargeTrade(order: LCDSellOrder): boolean {
    // Approximate USD value: quantity * ask_amount (in uregen) / 1e6 * estimated_price
    // Since we don't have a precise price here, use the raw ask_amount as a heuristic
    const askAmountNum = parseFloat(order.ask_amount) / 1e6; // uregen → REGEN
    const quantity = parseFloat(order.quantity);
    // Rough estimate assuming ~$0.04/REGEN
    const estimatedUsd = askAmountNum * 0.04 * quantity;
    return estimatedUsd > this.config.largeTradeThresholdUsd;
  }

  private loadCursor(): EventCursor {
    const defaults: EventCursor = {
      lastSellOrderId: "",
      lastRetirementHeight: "",
      lastPollTimestamp: "",
    };
    try {
      if (!fs.existsSync(this.cursorPath)) return defaults;
      const raw = fs.readFileSync(this.cursorPath, "utf-8");
      return { ...defaults, ...(JSON.parse(raw) as Partial<EventCursor>) };
    } catch {
      return defaults;
    }
  }

  private saveCursor(): void {
    try {
      const dir = path.dirname(this.cursorPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.cursorPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.cursor, null, 2), "utf-8");
      fs.renameSync(tmp, this.cursorPath);
    } catch (err) {
      this.logger.error({ err }, "Failed to save event cursor");
    }
  }
}
