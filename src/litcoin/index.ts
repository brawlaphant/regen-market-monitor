/**
 * Litcoin Protocol Module
 *
 * The agent is a full Litcoin participant:
 * - Burns LITCREDIT for AI inference (relay client)
 * - Tracks burn costs and ROI
 * - Exposes position data for Claude operation
 *
 * The economic loop: mine → earn → burn for inference → trade → accumulate REGEN → retire ecocredits
 */

export { RelayClient } from "./relay-client.js";
export type {
  RelayConfig,
  RelayAuthMethod,
  RelayHealth,
  LitcoinConfig,
  LitcoinPosition,
  LitcreditBurn,
  BurnLedger,
} from "./types.js";

/** Build relay config from environment variables */
export function buildRelayConfig(): {
  baseUrl: string;
  authMethod: "wallet" | "key" | "none";
  wallet?: string;
  apiKey?: string;
  timeoutMs: number;
  retryTimeoutMs: number;
  model: string;
} {
  const wallet = (process.env.LITCOIN_WALLET || "").trim();
  const apiKey = (process.env.LITCOIN_RELAY_KEY || "").trim();
  const baseUrl = (
    process.env.LITCREDIT_RELAY_URL || "https://api.litcoiin.xyz/v1"
  ).replace(/\/+$/, "");

  let authMethod: "wallet" | "key" | "none" = "none";
  if (wallet) authMethod = "wallet";
  else if (apiKey) authMethod = "key";

  return {
    baseUrl,
    authMethod,
    wallet: wallet || undefined,
    apiKey: apiKey || undefined,
    timeoutMs: parseInt(process.env.LITCREDIT_TIMEOUT_MS || "45000", 10),
    retryTimeoutMs: parseInt(process.env.LITCREDIT_RETRY_TIMEOUT_MS || "120000", 10),
    model: process.env.LITCREDIT_MODEL || "auto",
  };
}
