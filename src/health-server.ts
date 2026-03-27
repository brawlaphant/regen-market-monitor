import http from "node:http";
import type { HealthResponse, MarketSnapshot } from "./types.js";
import type { Logger } from "./logger.js";
import { handleSignalRoutes } from "./server/signals-routes.js";
import type { SignalStore } from "./signals/signal-store.js";
import type { SignalPublisher } from "./signals/signal-publisher.js";
import type { TuningReport } from "./tuner/threshold-tuner.js";
import type { CrossChainAggregator } from "./chain/cross-chain-aggregator.js";
import type { ArbitrageDetector } from "./chain/arbitrage-detector.js";
import type { TradingSignalStore } from "./signals/trading-signal-store.js";
import type { ExecutionLedger } from "./execution/execution-ledger.js";
import type { AccumulationStrategy } from "./strategies/accumulation-strategy.js";
import type { WalletRegistry } from "./chain/whale/wallet-registry.js";
import type { MovementDetector } from "./chain/whale/movement-detector.js";
import type { PatternAnalyzer } from "./chain/whale/pattern-analyzer.js";

/**
 * HTTP server exposing health, state, signal, and tuning endpoints.
 * GET /health         → agent status, last/next poll, MCP reachability, alerts today
 * GET /state          → full market snapshot (last known values from each tool)
 * GET /tuning-report  → threshold tuning analysis
 * GET /signals*       → signal routes (list, detail, SSE stream, schema, stats)
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
  /** Tuning analyzer function, set from index.ts */
  public tuningAnalyzer: (() => TuningReport) | null = null;
  /** Cross-chain intelligence, set from index.ts */
  public crossChainAggregator: CrossChainAggregator | null = null;
  public arbitrageDetector: ArbitrageDetector | null = null;
  public tradingSignalStore: TradingSignalStore | null = null;
  public executionLedger: ExecutionLedger | null = null;
  public accumulationStrategy: AccumulationStrategy | null = null;
  public walletRegistry: WalletRegistry | null = null;
  public movementDetector: MovementDetector | null = null;
  public patternAnalyzer: PatternAnalyzer | null = null;

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

      // Trading signal routes
      if (this.tradingSignalStore) {
        const tUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const tPath = tUrl.pathname;
        if (tPath === "/signals/trading") {
          const p = tUrl.searchParams;
          const signals = this.tradingSignalStore.getRecent(
            Math.min(parseInt(p.get("limit") || "20", 10), 200),
            {
              conviction: p.get("conviction") || undefined,
              direction: p.get("direction") || undefined,
              signal_class: p.get("signal_class") || undefined,
              active_only: p.get("active_only") === "true",
            }
          );
          this.jsonResponse(res, 200, { signals, active_count: this.tradingSignalStore.getActive().length, stats: this.tradingSignalStore.getStats() });
          return;
        }
        if (tPath === "/signals/trading/latest") {
          this.jsonResponse(res, 200, this.tradingSignalStore.getLatestPerClass());
          return;
        }
        if (tPath === "/signals/trading/performance") {
          const price = this.crossChainAggregator?.getLastSnapshot()?.weighted_price_usd ?? 0;
          this.jsonResponse(res, 200, this.tradingSignalStore.getPerformance(price));
          return;
        }
        const tIdMatch = tPath.match(/^\/signals\/trading\/([a-f0-9-]{36})$/);
        if (tIdMatch) {
          const sig = this.tradingSignalStore.getById(tIdMatch[1]);
          this.jsonResponse(res, sig ? 200 : 404, sig || { error: "not_found" });
          return;
        }
      }

      // Strategy/execution routes
      if (req.url === "/strategy/position" && this.accumulationStrategy) {
        const pos = this.accumulationStrategy.getPosition();
        const price = this.crossChainAggregator?.getLastSnapshot()?.weighted_price_usd ?? 0;
        this.jsonResponse(res, 200, { ...pos, current_price_usd: price, unrealized_pnl_pct: pos.avg_entry_price_usd > 0 ? Math.round(((price - pos.avg_entry_price_usd) / pos.avg_entry_price_usd) * 10000) / 100 : 0 });
        return;
      }
      if (this.executionLedger) {
        const eUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        if (eUrl.pathname === "/execution/ledger") {
          const limit = parseInt(eUrl.searchParams.get("limit") || "50", 10);
          const phase = eUrl.searchParams.get("phase") || undefined;
          this.jsonResponse(res, 200, this.executionLedger.getRecent(limit, phase));
          return;
        }
        if (eUrl.pathname === "/execution/summary") {
          const price = this.crossChainAggregator?.getLastSnapshot()?.weighted_price_usd ?? 0;
          this.jsonResponse(res, 200, { today: this.executionLedger.getDailySummary(), all_time: this.executionLedger.getPositionSummary(price) });
          return;
        }
      }

      // Whale routes
      if (req.url === "/whale/wallets" && this.walletRegistry) {
        this.jsonResponse(res, 200, this.walletRegistry.getTopByBalance(50));
        return;
      }
      if (this.movementDetector) {
        const wUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        if (wUrl.pathname === "/whale/movements") {
          const limit = parseInt(wUrl.searchParams.get("limit") || "50", 10);
          const sig = wUrl.searchParams.get("significance") || undefined;
          const movements = this.movementDetector.getRecent(limit, sig);
          this.jsonResponse(res, 200, movements);
          return;
        }
      }
      if (req.url === "/whale/patterns" && this.patternAnalyzer && this.movementDetector) {
        const movements = this.movementDetector.getRecent(500);
        const report = this.patternAnalyzer.analyze(movements, 24);
        this.jsonResponse(res, 200, report);
        return;
      }
      if (req.url === "/whale/stats" && this.walletRegistry && this.movementDetector) {
        const todayMvmts = this.movementDetector.getRecent(500).filter(m => new Date(m.timestamp).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10));
        this.jsonResponse(res, 200, {
          total_watched: this.walletRegistry.getTopByBalance(999).length,
          movements_today: todayMvmts.length,
          critical_today: todayMvmts.filter(m => m.significance === "critical").length,
        });
        return;
      }

      // Cross-chain routes
      if (req.url === "/cross-chain/snapshot" && this.crossChainAggregator) {
        const snap = this.crossChainAggregator.getLastSnapshot();
        this.jsonResponse(res, snap ? 200 : 503, snap || { error: "no data yet" });
        return;
      }
      if (req.url === "/cross-chain/history" && this.crossChainAggregator) {
        this.jsonResponse(res, 200, this.crossChainAggregator.loadHistory().slice(-168));
        return;
      }
      if (req.url === "/cross-chain/arbitrage" && this.arbitrageDetector) {
        this.jsonResponse(res, 200, this.arbitrageDetector.getRecentDetections(10));
        return;
      }

      if (req.url === "/health") {
        this.handleHealth(res);
      } else if (req.url === "/state") {
        this.handleState(res);
      } else if (req.url === "/tuning-report") {
        this.handleTuning(res);
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

  private handleTuning(res: http.ServerResponse): void {
    if (!this.tuningAnalyzer) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: false, reason: "tuner not initialized" }));
      return;
    }

    const report = this.tuningAnalyzer();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(report, null, 2));
  }

  private jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
