import type { MarketSignal, PublishStatus } from "../signal-schema.js";
import type { Logger } from "../../logger.js";

/**
 * Redis Streams publisher. Only active when REDIS_URL env var is set.
 * Publishes to main stream + per-agent routing streams.
 */
export class RedisPublisher {
  private client: any = null; // ioredis instance (dynamically imported)
  private connected = false;
  private streamKey: string;
  private maxLen: number;
  private logger: Logger;
  private messagesToday = 0;
  private todayStart = 0;

  constructor(logger: Logger) {
    this.logger = logger;
    this.streamKey = process.env.REDIS_STREAM_KEY || "regen:market:signals";
    this.maxLen = parseInt(process.env.REDIS_STREAM_MAXLEN || "10000", 10);
  }

  async init(): Promise<boolean> {
    const url = process.env.REDIS_URL;
    if (!url) return false;

    try {
      const ioredis = await import("ioredis");
      const Redis = ioredis.default ?? ioredis;
      this.client = new (Redis as any)(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => Math.min(times * 500, 5000),
      });

      this.client.on("connect", () => {
        this.connected = true;
        this.logger.info({ streamKey: this.streamKey }, "Redis connected");
      });

      this.client.on("error", (err: Error) => {
        this.connected = false;
        this.logger.warn({ err: err.message }, "Redis error");
      });

      this.client.on("close", () => {
        this.connected = false;
      });

      // Test connection
      await this.client.ping();
      this.connected = true;
      return true;
    } catch (err) {
      this.logger.warn({ err }, "Redis init failed — publishing disabled");
      return false;
    }
  }

  async publish(signal: MarketSignal): Promise<PublishStatus> {
    if (!this.client || !this.connected) {
      return { success: false, latency_ms: 0, error: "redis_unavailable" };
    }

    const start = Date.now();
    try {
      const payload = JSON.stringify(signal);

      // Main stream
      await this.client.xadd(
        this.streamKey, "MAXLEN", "~", this.maxLen, "*",
        "signal_id", signal.id,
        "signal_type", signal.signal_type,
        "severity", signal.severity,
        "payload", payload,
        "timestamp", signal.timestamp
      );

      // Per-agent routing streams
      for (const agent of signal.routing.target_agents) {
        await this.client.xadd(
          `regen:signals:${agent}`, "MAXLEN", "~", this.maxLen, "*",
          "signal_id", signal.id,
          "signal_type", signal.signal_type,
          "severity", signal.severity,
          "payload", payload,
          "timestamp", signal.timestamp
        );
      }

      this.trackDaily();
      return { success: true, latency_ms: Date.now() - start };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, latency_ms: Date.now() - start, error: errMsg };
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  get messagesTodayCount(): number { return this.messagesToday; }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => {});
      this.connected = false;
    }
  }

  private trackDaily(): void {
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
    if (day !== this.todayStart) { this.messagesToday = 0; this.todayStart = day; }
    this.messagesToday++;
  }
}
