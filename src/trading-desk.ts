/**
 * Trading Desk — standalone one-shot runner.
 *
 * Scans Polymarket + Hyperliquid, scores via LITCREDIT relay,
 * reports signals, and optionally executes trades.
 * Designed to run as a PM2 cron job (one-shot, not long-running).
 *
 * Usage:
 *   npm run trading-desk          # default dry-run
 *   npm run trading-desk:dry      # explicit paper trading
 *   npm run trading-desk:live     # live execution (requires funded wallets)
 */

import "dotenv/config";
import { createLogger } from "./logger.js";
import { RelayClient, buildRelayConfig } from "./litcoin/index.js";
import { LitcreditScorer } from "./scoring/litcredit-provider.js";
import { MultiVenueOrchestrator } from "./strategies/multi-venue-orchestrator.js";
import { SurplusRouter } from "./surplus/surplus-router.js";

const DATA_DIR = process.env.DATA_DIR || "./data";

async function main(): Promise<void> {
  const logger = createLogger(process.env.LOG_LEVEL || "info");
  const dryRun = (process.env.POLYMARKET_DRY_RUN || "true").toLowerCase() !== "false";
  const mode = dryRun ? "DRY RUN" : "LIVE";

  logger.info({ mode }, "Trading desk starting");

  // Litcoin relay
  const relayConfig = buildRelayConfig();
  if (relayConfig.authMethod === "none") {
    logger.error("LITCREDIT relay not configured. Set LITCOIN_WALLET or LITCOIN_RELAY_KEY.");
    process.exit(1);
  }

  const relay = new RelayClient(relayConfig, DATA_DIR, logger);
  const scorer = new LitcreditScorer(relay, logger);
  const surplus = new SurplusRouter(DATA_DIR, logger);
  const orchestrator = new MultiVenueOrchestrator(scorer, surplus, DATA_DIR, logger);

  // Check relay health
  const health = await relay.checkHealth();
  logger.info({ reachable: health.reachable, providers: health.relay_providers_online }, "Relay health");

  if (!health.reachable) {
    logger.warn("Relay unreachable — signals may be limited");
  }

  // Run all venues
  const result = await orchestrator.run(dryRun);

  // Report
  const totalSignals = result.venues.reduce((s, v) => s + v.signals_found, 0);
  const totalErrors = result.venues.reduce((s, v) => s + v.errors.length, 0);
  const burns = relay.getBurnStats();

  logger.info({
    mode,
    venues: result.venues.map(v => ({
      name: v.venue,
      signals: v.signals_found,
      trades: v.trades_executed,
      errors: v.errors.length,
    })),
    total_signals: totalSignals,
    litcredit_burned: burns.total_litcredit.toFixed(2),
    surplus: result.surplus_allocation,
  }, "Trading desk complete");

  // Send Telegram summary if configured
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const lines = [
      `<b>Trading Desk (${mode})</b>`,
      "",
    ];
    for (const v of result.venues) {
      lines.push(`<b>${v.venue}</b>: ${v.signals_found} signals, ${v.trades_executed} trades${v.errors.length > 0 ? `, ${v.errors.length} errors` : ""}`);
    }
    lines.push("", `LITCREDIT burned: ${burns.total_litcredit.toFixed(2)} LC`);
    if (result.surplus_allocation.routed_to_regen > 0) {
      lines.push(`Surplus: $${result.surplus_allocation.routed_to_regen.toFixed(2)} → REGEN`);
    }

    try {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: lines.join("\n"),
          parse_mode: "HTML",
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { /* non-critical */ }
  }

  if (totalErrors > 0) {
    logger.warn({ errors: result.venues.flatMap(v => v.errors) }, "Venue errors");
  }
}

main().catch((err) => {
  console.error("[trading-desk] Fatal:", err);
  process.exit(1);
});
