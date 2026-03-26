import http from "node:http";
import type { HealthResponse, MarketSnapshot } from "./types.js";
import type { Logger } from "./logger.js";

/**
 * Lightweight HTTP health server.
 * GET /health → agent status, last/next poll, MCP reachability, alerts today
 * GET /state  → full market snapshot (last known values from each tool)
 */
export class HealthServer {
  private server: http.Server;
  private logger: Logger;
  private startedAt = Date.now();

  /** Mutable state updated by the scheduler each cycle */
  public lastPollAt: Date | null = null;
  public nextPollAt: Date | null = null;
  public mcpReachable = true;
  public alertsFiredToday = 0;
  public snapshot: MarketSnapshot | null = null;

  constructor(port: number, logger: Logger) {
    this.logger = logger;

    this.server = http.createServer((req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
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

    const body: HealthResponse = {
      status,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      nextPollAt: this.nextPollAt?.toISOString() ?? null,
      mcpReachable: this.mcpReachable,
      alertsFiredToday: this.alertsFiredToday,
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
    };

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
