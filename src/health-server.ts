import http from "node:http";
import type { HealthResponse, MarketSnapshot } from "./types.js";
import type { Logger } from "./logger.js";
import { handleSignalRoutes } from "./server/signals-routes.js";
import type { SignalStore } from "./signals/signal-store.js";
import type { SignalPublisher } from "./signals/signal-publisher.js";

/**
 * HTTP server exposing health, state, and signal endpoints.
 */
export class HealthServer {
  private server: http.Server;
  private logger: Logger;
  private startedAt = Date.now();

  public lastPollAt: Date | null = null;
  public nextPollAt: Date | null = null;
  public mcpReachable = true;
  public alertsFiredToday = 0;
  public snapshot: MarketSnapshot | null = null;

  /** Signal infrastructure — set from index.ts after init */
  public signalStore: SignalStore | null = null;
  public signalPublisher: SignalPublisher | null = null;

  constructor(port: number, logger: Logger) {
    this.logger = logger;

    this.server = http.createServer((req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }

      // Signal routes first
      if (this.signalStore && this.signalPublisher) {
        if (handleSignalRoutes(req, res, this.signalStore, this.signalPublisher, this.logger)) {
          return;
        }
      }

      if (req.url === "/health") {
        this.handleHealth(res);
      } else if (req.url === "/state") {
        this.handleState(res);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      }
    });

    this.server.listen(port, () => {
      this.logger.info({ port }, "Health server listening");
    });
  }

  private handleHealth(res: http.ServerResponse): void {
    const status: HealthResponse["status"] = this.lastPollAt
      ? this.mcpReachable
        ? "ok"
        : "degraded"
      : "starting";

    const body: Record<string, unknown> = {
      status,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      nextPollAt: this.nextPollAt?.toISOString() ?? null,
      mcpReachable: this.mcpReachable,
      alertsFiredToday: this.alertsFiredToday,
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
    };

    // Broadcasting health
    if (this.signalPublisher) {
      const s = this.signalPublisher.stats;
      body.broadcasting = {
        redis: {
          enabled: s.publishers_active.includes("redis"),
          connected: s.redis_connected,
          stream_key: process.env.REDIS_STREAM_KEY || "regen:market:signals",
          messages_today: s.redis_messages_today,
        },
        webhook: {
          enabled: s.publishers_active.includes("webhook"),
          targets: s.webhook_targets,
          deliveries_today: s.webhook_deliveries_today,
          failures_today: s.webhook_failures_today,
        },
        sse: {
          enabled: true,
          clients_connected: s.sse_clients_connected,
        },
        signals_published_today: s.signals_published_today,
        last_signal_at: s.last_signal_at,
      };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  }

  private handleState(res: http.ServerResponse): void {
    if (!this.snapshot) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no data yet", status: "starting" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.snapshot, null, 2));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
