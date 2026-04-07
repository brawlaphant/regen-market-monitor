/**
 * Multi-Venue Strategy Orchestrator
 *
 * Coordinates signal scanning across four venues:
 * Polymarket, Hyperliquid, GMX, and REGEN (accumulation + Coinstore).
 *
 * All venues are signal-only today. Per-venue budget caps are configured
 * via each venue's own env vars (e.g. GMX_DAILY_CAP, POLYMARKET_DAILY_CAP).
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
import {
  scanFunding as gmxScanFunding,
  scanMomentum as gmxScanMomentum,
  scanGmPools,
  loadLedger as gmxLoadLedger,
  saveLedger as gmxSaveLedger,
  buildGmxConfig,
} from "../venues/gmx/index.js";
import type { GmxSignal } from "../venues/gmx/types.js";
import {
  scanParentLedger,
  loadLedger as baseEcoLoadLedger,
  saveLedger as baseEcoSaveLedger,
  buildConfig as buildBaseEcoConfig,
  recordSignalGeneration,
} from "../venues/base-ecowealth/index.js";
import type { BaseEcowealthSignal } from "../venues/base-ecowealth/types.js";

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
  private polyClient: PolymarketClient | null = null;

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
  }

  /** Run all venue strategies and return combined results.
   *  All venues are signal-only today — execution adapters will be wired per-venue
   *  when wallets are funded and signal quality is proven.
   */
  async run(): Promise<MultiVenueRunResult> {
    const results: VenueResult[] = [];

    // Run all venues in parallel
    const [polyResult, hlResult, gmxResult, baseEcoResult] = await Promise.allSettled([
      this.runPolymarket(),
      this.runHyperliquid(),
      this.runGmx(),
      this.runBaseEcowealth(),
    ]);

    const rejectMsg = (reason: unknown): string =>
      reason instanceof Error ? reason.message : "unknown error";
    const emptyResult = (venue: string, reason: unknown): VenueResult =>
      ({ venue, signals_found: 0, trades_executed: 0, spent_usd: 0, realized_pnl: 0, errors: [rejectMsg(reason)] });

    if (polyResult.status === "fulfilled") results.push(polyResult.value);
    else results.push(emptyResult("polymarket", polyResult.reason));

    if (hlResult.status === "fulfilled") results.push(hlResult.value);
    else results.push(emptyResult("hyperliquid", hlResult.reason));

    if (gmxResult.status === "fulfilled") results.push(gmxResult.value);
    else results.push(emptyResult("gmx", gmxResult.reason));

    if (baseEcoResult.status === "fulfilled") results.push(baseEcoResult.value);
    else results.push(emptyResult("base-ecowealth", baseEcoResult.reason));

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
      if (!this.polyClient) this.polyClient = new PolymarketClient(this.logger);
      const markets = await this.polyClient.fetchMarkets(80);

      if (markets.length === 0) {
        result.errors.push("No active markets found");
        return result;
      }

      // Run all 4 strategies
      const allSignals: ScoredMarket[] = [];

      const [spray, worldview, contrarian, closer] = await Promise.allSettled([
        runSpray(markets, this.polyClient!, this.scorer),
        runWorldview(markets, this.polyClient!, this.scorer),
        runContrarian(markets, this.polyClient!, this.scorer),
        runCloser(markets, this.polyClient!, this.scorer),
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

      const sdkConfig: Record<string, unknown> = { enableWs: false };
      if (config.privateKey) sdkConfig.privateKey = config.privateKey;
      const sdk = new Hyperliquid(sdkConfig as ConstructorParameters<typeof Hyperliquid>[0]);
      let connected = false;
      await sdk.connect();
      connected = true;

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

        const ledger = loadLedger(this.dataDir);
        saveLedger(this.dataDir, ledger);

        this.logger.info(
          { funding: fundingSignals.length, momentum: momentumSignals.length },
          "Hyperliquid scan complete"
        );
      } finally {
        if (connected) sdk.disconnect();
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      this.logger.warn({ err }, "Hyperliquid venue run failed");
    }

    return result;
  }

  private async runGmx(): Promise<VenueResult> {
    const result: VenueResult = {
      venue: "gmx",
      signals_found: 0,
      trades_executed: 0,
      spent_usd: 0,
      realized_pnl: 0,
      errors: [],
    };

    const config = buildGmxConfig();

    try {
      const { GmxSdk } = await import("@gmx-io/sdk");
      const sdk = new GmxSdk({ chainId: config.chainId });

      const fundingSignals = await gmxScanFunding(sdk, config, this.logger);
      const momentumSignals = await gmxScanMomentum(sdk, config, this.logger);
      const poolSignals = await scanGmPools(sdk, config, this.logger);

      const allSignals: GmxSignal[] = [...fundingSignals, ...momentumSignals, ...poolSignals];
      allSignals.sort((a, b) => {
        if (a.strategy === "funding" && b.strategy !== "funding") return -1;
        if (b.strategy === "funding" && a.strategy !== "funding") return 1;
        return b.size_usd - a.size_usd;
      });

      result.signals_found = allSignals.length;

      const ledger = gmxLoadLedger(this.dataDir);
      gmxSaveLedger(this.dataDir, ledger);

      this.logger.info(
        { funding: fundingSignals.length, momentum: momentumSignals.length, pools: poolSignals.length },
        "GMX scan complete"
      );
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      this.logger.warn({ err }, "GMX venue run failed");
    }

    return result;
  }

  private async runBaseEcowealth(): Promise<VenueResult> {
    const result: VenueResult = {
      venue: "base-ecowealth",
      signals_found: 0,
      trades_executed: 0,
      spent_usd: 0,
      realized_pnl: 0,
      errors: [],
    };

    const config = buildBaseEcoConfig();

    try {
      const signals = await scanParentLedger(config);
      result.signals_found = signals.length;

      // Record signal generation to ledger
      if (signals.length > 0) {
        const pnl = signals[0]?.metrics.pnl_24h || 0;
        const gas = signals[0]?.metrics.gas_spent_24h || 0;
        recordSignalGeneration(signals.length, pnl, gas, 0, 0);
      }

      this.logger.info(
        { signals: signals.length, confidence_threshold: config.confidenceThreshold },
        "Base EcoWealth scan complete"
      );

      // Signal-only for now — execution adapter would go here
      // When wired to parent wallet, this would trigger REGEN buys on surplus

    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      this.logger.warn({ err }, "Base EcoWealth venue run failed");
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
