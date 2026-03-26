import type { MarketSignal, PublishResult, PublishStatus, BroadcastChannel } from "./signal-schema.js";
import { MarketSignalSchema } from "../schemas.js";
import { RedisPublisher } from "./publishers/redis-publisher.js";
import { WebhookPublisher } from "./publishers/webhook-publisher.js";
import { SignalStore } from "./signal-store.js";
import type { Logger } from "../logger.js";
import http from "node:http";

const NULL_STATUS: PublishStatus = { success: false, latency_ms: 0, error: "not_configured" };

/**
 * Central signal publisher — fans out to all configured channels.
 * Also manages SSE client connections for real-time streaming.
 */
export class SignalPublisher {
  private redis: RedisPublisher;
  private webhook: WebhookPublisher;
  private store: SignalStore;
  private logger: Logger;
  private redisEnabled = false;
  private webhookEnabled = false;
  private sseClients: Set<http.ServerResponse> = new Set();
  private maxSseConnections: number;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(store: SignalStore, logger: Logger) {
    this.store = store;
    this.logger = logger;
    this.redis = new RedisPublisher(logger);
    this.webhook = new WebhookPublisher(logger);
    this.maxSseConnections = parseInt(process.env.SSE_MAX_CONNECTIONS || "10", 10);
  }

  async init(): Promise<void> {
    this.redisEnabled = await this.redis.init();
    this.webhookEnabled = this.webhook.init();

    const channels: string[] = ["rest"];
    if (this.redisEnabled) channels.push("redis");
    if (this.webhookEnabled) channels.push("webhook");

    if (!this.redisEnabled && !this.webhookEnabled) {
      this.logger.info("No external publishers configured — signals available via REST only");
    } else {
      this.logger.info({ channels }, "Signal publishers active");
    }

    // SSE keepalive
    this.keepaliveTimer = setInterval(() => {
      for (const res of this.sseClients) {
        try { res.write(": keepalive\n\n"); } catch { this.removeSseClient(res); }
      }
    }, 30_000);
  }

  get configuredChannels(): BroadcastChannel[] {
    const ch: BroadcastChannel[] = ["rest"];
    if (this.redisEnabled) ch.push("redis");
    if (this.webhookEnabled) ch.push("webhook");
    return ch;
  }

  async publish(signal: MarketSignal): Promise<PublishResult> {
    // Validate first
    const validation = MarketSignalSchema.safeParse(signal);
    if (!validation.success) {
      this.logger.error({ signal_id: signal.id, error: validation.error.message }, "Signal validation failed — not publishing");
      return { signal_id: signal.id, redis: NULL_STATUS, webhook: NULL_STATUS, stored: false };
    }

    // Store always
    this.store.store(signal);

    // Publish to all channels simultaneously
    const [redisResult, webhookResult] = await Promise.allSettled([
      this.redisEnabled ? this.redis.publish(signal) : Promise.resolve(NULL_STATUS),
      this.webhookEnabled ? this.webhook.publish(signal) : Promise.resolve(NULL_STATUS),
    ]);

    const redis = redisResult.status === "fulfilled" ? redisResult.value : { success: false, latency_ms: 0, error: String((redisResult as PromiseRejectedResult).reason) };
    const webhook = webhookResult.status === "fulfilled" ? webhookResult.value : { success: false, latency_ms: 0, error: String((webhookResult as PromiseRejectedResult).reason) };

    // Fan out to SSE clients
    this.broadcastSse(signal);

    this.logger.info(
      { signal_id: signal.id, signal_type: signal.signal_type, severity: signal.severity, redis: redis.success, webhook: webhook.success, sse_clients: this.sseClients.size },
      "Signal published"
    );

    return { signal_id: signal.id, redis, webhook, stored: true };
  }

  // ─── SSE Management ───────────────────────────────────────────────

  addSseClient(res: http.ServerResponse): boolean {
    if (this.sseClients.size >= this.maxSseConnections) return false;
    this.sseClients.add(res);
    res.on("close", () => this.removeSseClient(res));
    return true;
  }

  private removeSseClient(res: http.ServerResponse): void {
    this.sseClients.delete(res);
  }

  private broadcastSse(signal: MarketSignal): void {
    const data = `event: signal\ndata: ${JSON.stringify(signal)}\nid: ${signal.id}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(data); } catch { this.removeSseClient(res); }
    }
  }

  closeSseClients(): void {
    for (const res of this.sseClients) {
      try { res.end(); } catch {}
    }
    this.sseClients.clear();
  }

  // ─── Health stats ─────────────────────────────────────────────────

  get stats() {
    return {
      publishers_active: this.configuredChannels,
      redis_connected: this.redisEnabled && this.redis.isConnected(),
      webhook_targets: this.webhookEnabled ? this.webhook.targetCount : 0,
      sse_clients_connected: this.sseClients.size,
      signals_published_today: this.store.signalsPublishedToday,
      last_signal_at: this.store.lastSignalAt,
      redis_messages_today: this.redis.messagesTodayCount,
      webhook_deliveries_today: this.webhookEnabled ? this.webhook.deliveriesTodayCount : 0,
      webhook_failures_today: this.webhookEnabled ? this.webhook.failuresTodayCount : 0,
    };
  }

  async close(): Promise<void> {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.closeSseClients();
    await this.redis.close();
  }
}
