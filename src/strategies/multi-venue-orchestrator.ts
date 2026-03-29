/**
 * Multi-Venue Strategy Orchestrator
 *
 * Extends the existing REGEN-only orchestrator to coordinate across
 * three venues: REGEN (accumulation + Coinstore), Polymarket, Hyperliquid.
 *
 * Budget allocation (env-tunable):
 * - Hyperliquid: 40% of daily cap
 * - Polymarket: 40% of daily cap
 * - REGEN: 20% of daily cap
 *
 * Surplus from trading P&L routes to extra REGEN accumulation.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import type { LitcreditScorer } from "../scoring/litcredit-provider.js";
import type { SurplusRouter } from "../surplus/surplus-router.js";
import { PolymarketClient } from "../venues/polymarket/client.js";
import {
  runSpray,
  runWorldview,
  runContrarian,
  runCloser,
  dedupeAndRank,
} from "../venues/polymarket/strategies.js";
import type { ScoredMarket } from "../venues/polymarket/types.js";
import {
  scanFunding,
  scanMomentum,
  loadLedger,
  saveLedger,
  buildHyperliquidConfig,
} from "../venues/hyperliquid/index.js";
import type { HyperliquidSignal } from "../venues/hyperliquid/types.js";

export interface VenueResult {
  venue: string;
  signals_found: number;
  trades_executed: number;
  spent_usd: number;
  realized_pnl: number;
  errors: string[];
}

export interface MultiVenueRunResult {
  timestamp: string;
  venues: VenueResult[];
  surplus_allocation: { available: number; routed_to_regen: number; reason: string };
  litcredit_burned: number;
}

export class MultiVenueOrchestrator {
  private logger: Logger;
  private scorer: LitcreditScorer;
  private surplus: SurplusRouter;
  private dataDir: string;

  private dailyCap: number;
  private hlPct: number;
  private polyPct: number;
  private regenPct: number;

  constructor(
    scorer: LitcreditScorer,
    surplus: SurplusRouter,
    dataDir: string,
    logger: Logger
  ) {
    this.scorer = scorer;
    this.surplus = surplus;
    this.dataDir = dataDir;
    this.logger = logger;

    this.dailyCap = parseFloat(process.env.TRADING_DESK_DAILY_CAP || "150");
    this.hlPct = parseFloat(process.env.TRADING_DESK_HL_PCT || "40") / 100;
    this.polyPct = parseFloat(process.env.TRADING_DESK_POLY_PCT || "40") / 100;
    this.regenPct = parseFloat(process.env.TRADING_DESK_REGEN_PCT || "20") / 100;
  }

  /** Run all venue strategies and return combined results.
   *  @param dryRun If true (default), scan only — no execution.
   */
  async run(dryRun = true): Promise<MultiVenueRunResult> {
    const results: VenueResult[] = [];

    // Run venues — Polymarket and Hyperliquid can run in parallel
    const [polyResult, hlResult] = await Promise.allSettled([
      this.runPolymarket(),
      this.runHyperliquid(),
    ]);

    const rejectMsg = (reason: unknown): string =>
      reason instanceof Error ? reason.message : "unknown error";

    if (polyResult.status === "fulfilled") results.push(polyResult.value);
    else results.push({ venue: "polymarket", signals_found: 0, trades_executed: 0, spent_usd: 0, realized_pnl: 0, errors: [rejectMsg(polyResult.reason)] });

    if (hlResult.status === "fulfilled") results.push(hlResult.value);
    else results.push({ venue: "hyperliquid", signals_found: 0, trades_executed: 0, spent_usd: 0, realized_pnl: 0, errors: [rejectMsg(hlResult.reason)] });

    // Record P&L for each venue
    for (const r of results) {
      this.surplus.recordVenuePnl(r.venue, r.realized_pnl, 0, r.trades_executed, r.spent_usd);
    }

    // Calculate surplus routing
    const surplusCalc = this.surplus.calculateSurplus();

    const result: MultiVenueRunResult = {
      timestamp: new Date().toISOString(),
      venues: results,
      surplus_allocation: {
        available: surplusCalc.available_surplus_usd,
        routed_to_regen: surplusCalc.routed_to_regen_usd,
        reason: surplusCalc.reason,
      },
      litcredit_burned: 0, // filled by caller from relay client stats
    };

    this.saveArtifact(result);
    return result;
  }

  // ─── Venue runners ────────────────────────────────────────────────

  private async runPolymarket(): Promise<VenueResult> {
    const result: VenueResult = {
      venue: "polymarket",
      signals_found: 0,
      trades_executed: 0,
      spent_usd: 0,
      realized_pnl: 0,
      errors: [],
    };

    if (!this.scorer.isConfigured) {
      result.errors.push("LITCREDIT relay not configured — cannot score markets");
      return result;
    }

    try {
      const client = new PolymarketClient(this.logger);
      const markets = await client.fetchMarkets(80);

      if (markets.length === 0) {
        result.errors.push("No active markets found");
        return result;
      }

      // Run all 4 strategies
      const allSignals: ScoredMarket[] = [];

      const [spray, worldview, contrarian, closer] = await Promise.allSettled([
        runSpray(markets, client, this.scorer),
        runWorldview(markets, client, this.scorer),
        runContrarian(markets, client, this.scorer),
        runCloser(markets, client, this.scorer),
      ]);

      if (spray.status === "fulfilled") allSignals.push(...spray.value);
      if (worldview.status === "fulfilled") allSignals.push(...worldview.value);
      if (contrarian.status === "fulfilled") allSignals.push(...contrarian.value);
      if (closer.status === "fulfilled") allSignals.push(...closer.value);

      const ranked = dedupeAndRank(allSignals);
      result.signals_found = ranked.length;

      this.logger.info(
        { markets: markets.length, raw: allSignals.length, ranked: ranked.length },
        "Polymarket scan complete"
      );

      // Signal-only for now — execution adapter would go here
      // When execution is enabled, this would call the CLOB API

    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      this.logger.warn({ err }, "Polymarket venue run failed");
    }

    return result;
  }

  private async runHyperliquid(): Promise<VenueResult> {
    const result: VenueResult = {
      venue: "hyperliquid",
      signals_found: 0,
      trades_executed: 0,
      spent_usd: 0,
      realized_pnl: 0,
      errors: [],
    };

    const config = buildHyperliquidConfig();

    try {
      const { Hyperliquid } = await import("hyperliquid");

      const sdkConfig: ConstructorParameters<typeof Hyperliquid>[0] = { enableWs: false };
      if (config.privateKey) (sdkConfig as Record<string, unknown>).privateKey = config.privateKey;
      const sdk = new Hyperliquid(sdkConfig);
      await sdk.connect();

      try {
        const fundingSignals = await scanFunding(sdk, config, this.logger);
        const momentumSignals = await scanMomentum(sdk, config, this.logger);

        const allSignals: HyperliquidSignal[] = [...fundingSignals, ...momentumSignals];
        allSignals.sort((a, b) => {
          if (a.strategy === "funding" && b.strategy !== "funding") return -1;
          if (b.strategy === "funding" && a.strategy !== "funding") return 1;
          return b.size_usd - a.size_usd;
        });

        result.signals_found = allSignals.length;

        // Track in ledger
        const ledger = loadLedger(this.dataDir);
        // Signal-only for now — execution goes through the Hyperliquid SDK
        saveLedger(this.dataDir, ledger);

        this.logger.info(
          { funding: fundingSignals.length, momentum: momentumSignals.length },
          "Hyperliquid scan complete"
        );
      } finally {
        sdk.disconnect();
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      this.logger.warn({ err }, "Hyperliquid venue run failed");
    }

    return result;
  }

  // ─── Artifacts ────────────────────────────────────────────────────

  private saveArtifact(result: MultiVenueRunResult): void {
    try {
      const dir = path.join(this.dataDir, "trading-desk");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      const file = path.join(dir, `run-${stamp}.json`);
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Artifact save failed");
    }
  }
}
