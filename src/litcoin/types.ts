/**
 * Litcoin Protocol types.
 *
 * The agent is a full participant in the Litcoin protocol:
 * - Burns LITCREDIT for every AI inference call
 * - Can mine through comprehension + research tasks
 * - Manages staking, vault, and escrow positions
 * - Earns more than it burns — self-sustaining loop
 */

/** LITCREDIT relay authentication method */
export type RelayAuthMethod = "wallet" | "key" | "none";

/** LITCREDIT relay configuration */
export interface RelayConfig {
  baseUrl: string;
  authMethod: RelayAuthMethod;
  wallet?: string;
  apiKey?: string;
  timeoutMs: number;
  retryTimeoutMs: number;
  model: string;
}

/** A single LITCREDIT burn event from an inference call */
export interface LitcreditBurn {
  id: string;
  timestamp: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  litcredit_cost: number; // 1 LC per 1k tokens
  purpose: string; // e.g. "polymarket_scoring", "regen_analysis"
  relay_latency_ms: number;
}

/** Running burn ledger — persisted daily */
export interface BurnLedger {
  date: string;
  total_burns: number;
  total_litcredit: number;
  total_tokens: number;
  burns: LitcreditBurn[];
}

/** Litcoin position snapshot (mirrors Vanguard data) */
export interface LitcoinPosition {
  wallet: string;
  timestamp: string;
  // Balances
  litcoin_balance: number;
  litcredit_balance: number;
  // Staking
  staked_amount: number;
  staking_tier: number;
  staking_apy: number;
  // Vault
  vault_id: number | null;
  vault_collateral: number;
  vault_debt: number;
  vault_health: number;
  // Guild
  guild_id: number | null;
  guild_deposited: number;
  guild_boost_pct: number;
  // Escrow (for relay inference)
  escrow_balance: number;
  // Mining
  mining_active: boolean;
  mining_type: "comprehension" | "research" | "relay" | "idle";
  unclaimed_rewards: number;
}

/** Relay health status */
export interface RelayHealth {
  reachable: boolean;
  latency_ms: number;
  relay_providers_online: number;
  escrow_sufficient: boolean;
  last_check: string;
}

/** Litcoin protocol module configuration */
export interface LitcoinConfig {
  relay: RelayConfig;
  /** Wallet address for position tracking */
  wallet?: string;
  /** Whether to track burn costs */
  trackBurns: boolean;
  /** Minimum escrow balance before warning */
  escrowWarningThreshold: number;
  /** Data directory for ledger persistence */
  dataDir: string;
}
