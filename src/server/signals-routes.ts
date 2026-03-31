import http from "node:http";
import { SignalStore } from "../signals/signal-store.js";
import { SignalPublisher } from "../signals/signal-publisher.js";
import { MarketSignalSchema } from "../schemas.js";
import type { Logger } from "../logger.js";

let jsonSchemaCache: string | null = null;

/**
 * Handle signal-related HTTP routes.
 * Returns true if the request was handled, false if not matched.
 */
export function handleSignalRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: SignalStore,
  publisher: SignalPublisher,
  logger: Logger
): boolean {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (req.method !== "GET") return false;

  if (path === "/signals") {
    handleGetSignals(url, res, store);
    return true;
  }

  if (path === "/signals/stream") {
    handleSseStream(res, publisher, logger);
    return true;
  }

  if (path === "/signals/schema") {
    handleGetSchema(res);
    return true;
  }

  if (path === "/signals/stats") {
    handleGetStats(res, store, publisher);
    return true;
  }

  // /signals/:id
  const idMatch = path.match(/^\/signals\/([a-f0-9-]{36})$/);
  if (idMatch) {
    handleGetSignalById(idMatch[1], res, store);
    return true;
  }

  return false;
}

function handleGetSignals(url: URL, res: http.ServerResponse, store: SignalStore): void {
  const params = url.searchParams;
  const limit = Math.min(parseInt(params.get("limit") || "50", 10), 200);
  const filters: any = {};
  if (params.get("type")) filters.signal_type = params.get("type");
  if (params.get("severity")) filters.severity = params.get("severity");
  if (params.get("since")) filters.since = params.get("since");
  if (params.get("agent")) filters.agent_id = params.get("agent");

  const signals = store.getRecent(limit, filters);
  const counts = store.count();

  json(res, 200, {
    signals,
    count: signals.length,
    total_stored: counts.total,
    oldest_available: store.oldest,
  });
}

function handleGetSignalById(id: string, res: http.ServerResponse, store: SignalStore): void {
  const signal = store.getById(id);
  if (!signal) {
    json(res, 404, { error: "not_found", id });
    return;
  }
  json(res, 200, signal);
}

function handleSseStream(
  res: http.ServerResponse,
  publisher: SignalPublisher,
  logger: Logger
): void {
  const added = publisher.addSseClient(res);
  if (!added) {
    json(res, 503, { error: "max_sse_connections_reached" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  logger.debug("SSE client connected");

  // Heartbeat every 15s to keep proxy/browser from killing idle connection
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 15_000);
  res.on("close", () => clearInterval(heartbeat));
}

function handleGetSchema(res: http.ServerResponse): void {
  if (!jsonSchemaCache) {
    // Generate a simplified JSON schema representation from the Zod schema description
    jsonSchemaCache = JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "MarketSignal",
      description: "Canonical signal type for the Regen agent ecosystem. Version 1.0.",
      type: "object",
      required: ["id", "version", "source", "agent_id", "signal_type", "severity", "timestamp", "data", "context", "routing"],
      properties: {
        id: { type: "string", format: "uuid" },
        version: { type: "string", const: "1.0" },
        source: { type: "string", const: "regen-market-monitor" },
        agent_id: { type: "string", const: "AGENT-003" },
        signal_type: { type: "string", enum: ["PRICE_ANOMALY", "PRICE_MOVEMENT", "LIQUIDITY_WARNING", "LOW_SUPPLY", "GOAL_COMPLETED", "CURATION_DEGRADED", "MARKET_REPORT", "MANIPULATION_ALERT"] },
        severity: { type: "string", enum: ["INFO", "WARNING", "CRITICAL"] },
        timestamp: { type: "string", format: "date-time" },
        data: { type: "object", description: "Discriminated union on signal_type — see signal-schema.ts for per-type definitions" },
        context: {
          type: "object",
          properties: {
            triggered_by: { type: "string", enum: ["scheduled_poll", "event_watcher", "manual"] },
            workflow_id: { type: "string" },
            poll_sequence: { type: "integer" },
            related_signal_ids: { type: "array", items: { type: "string" } },
          },
        },
        routing: {
          type: "object",
          properties: {
            target_agents: { type: "array", items: { type: "string", enum: ["AGENT-001", "AGENT-002", "AGENT-003", "AGENT-004"] } },
            broadcast_channels: { type: "array", items: { type: "string", enum: ["redis", "webhook", "rest"] } },
            ttl_seconds: { type: "integer" },
            priority: { type: "integer", enum: [1, 2, 3] },
          },
        },
      },
    }, null, 2);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(jsonSchemaCache);
}

function handleGetStats(
  res: http.ServerResponse,
  store: SignalStore,
  publisher: SignalPublisher
): void {
  const counts = store.count();
  json(res, 200, { ...counts, ...publisher.stats });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}
