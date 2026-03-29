/**
 * Polymarket Venue — prediction market signals + execution.
 *
 * Runs 4 strategies (Spray, Worldview, Contrarian, Closer) against live markets,
 * scores via LITCREDIT relay, deduplicates, and produces ranked signals.
 */

export { PolymarketClient } from "./client.js";
export {
  runSpray,
  runWorldview,
  runContrarian,
  runCloser,
  dedupeAndRank,
  computeBetSize,
} from "./strategies.js";
export type { PolymarketEvent, PolymarketMarket, ScoredMarket } from "./types.js";
export { categorizeMarket } from "./types.js";
