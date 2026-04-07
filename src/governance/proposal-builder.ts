/**
 * AGENT-003 Governance Proposal Builder
 *
 * Constructs governance proposals for Regen Network.
 * Authority level: Layer 1-2 (can propose, not execute).
 *
 * B4.1 + B4.2 + B4.3 + B4.4 implementation
 */

import type { Logger } from "../logger.js";

// ── B4.1: Proposal Types ────────────────────────────────────────────

export type ProposalType = "FreezeMarket" | "EmergencyStop" | "ParameterChange";

export interface FreezeMarketProposal {
  type: "FreezeMarket";
  market_id: string;
  reason: string;
  z_score: number;
  confidence: number;
}

export interface EmergencyStopProposal {
  type: "EmergencyStop";
  entity: string;
  reason: string;
  severity: "low" | "medium" | "high" | "critical";
}

export interface ParameterChangeProposal {
  type: "ParameterChange";
  contract_address: string;
  parameter: string;
  current_value: string;
  proposed_value: string;
  rationale: string;
}

export type Proposal = FreezeMarketProposal | EmergencyStopProposal | ParameterChangeProposal;

// ── B4.2: Confidence Gate ───────────────────────────────────────────

export interface ProposalEvaluationResult {
  valid: boolean;
  confidence: number;
  z_score?: number;
  reason: string;
}

/**
 * Evaluate whether a signal should trigger a proposal.
 *
 * Gate: z-score >= 3.5 AND confidence >= 0.85
 */
export function evaluateProposalTrigger(
  signalConfidence: number,
  zScore: number,
  logger: Logger
): ProposalEvaluationResult {
  const MIN_Z_SCORE = 3.5;
  const MIN_CONFIDENCE = 0.85;

  if (zScore < MIN_Z_SCORE) {
    return {
      valid: false,
      confidence: signalConfidence,
      z_score: zScore,
      reason: `Z-score ${zScore} below threshold ${MIN_Z_SCORE}`,
    };
  }

  if (signalConfidence < MIN_CONFIDENCE) {
    return {
      valid: false,
      confidence: signalConfidence,
      z_score: zScore,
      reason: `Confidence ${signalConfidence} below threshold ${MIN_CONFIDENCE}`,
    };
  }

  logger.info({ z_score: zScore, confidence: signalConfidence }, "Proposal threshold met");

  return {
    valid: true,
    confidence: signalConfidence,
    z_score: zScore,
    reason: "Passed confidence gates",
  };
}

// ── B4.3: Telegram Approval Flow ────────────────────────────────────

export interface PendingApproval {
  proposal_id: string;
  proposal: Proposal;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  approved_at?: string;
  admin_decision?: "approve" | "reject";
  reason?: string;
}

export class ApprovalQueue {
  private queue: Map<string, PendingApproval> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Queue a proposal for admin approval.
   * Returns proposal_id.
   */
  queueForApproval(proposal: Proposal): string {
    const proposalId = `prop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pending: PendingApproval = {
      proposal_id: proposalId,
      proposal,
      status: "pending",
      requested_at: new Date().toISOString(),
    };

    this.queue.set(proposalId, pending);
    this.logger.info({ proposal_id: proposalId, type: proposal.type }, "Proposal queued for admin approval");

    return proposalId;
  }

  /**
   * Get pending approvals for telegram notification.
   */
  getPending(): PendingApproval[] {
    return Array.from(this.queue.values()).filter((p) => p.status === "pending");
  }

  /**
   * Admin approves or rejects a proposal.
   */
  recordDecision(
    proposalId: string,
    decision: "approve" | "reject",
    reason?: string
  ): PendingApproval | null {
    const pending = this.queue.get(proposalId);
    if (!pending) return null;

    pending.status = decision === "approve" ? "approved" : "rejected";
    pending.admin_decision = decision;
    pending.approved_at = new Date().toISOString();
    pending.reason = reason;

    this.logger.info(
      { proposal_id: proposalId, decision, reason },
      "Proposal decision recorded"
    );

    return pending;
  }

  /**
   * Get a specific proposal.
   */
  getProposal(proposalId: string): PendingApproval | null {
    return this.queue.get(proposalId) || null;
  }
}

// ── B4.4: On-Chain Submission ───────────────────────────────────────

export interface RegenChainConfig {
  rpcUrl: string;
  lcdUrl: string;
  chainId: string;
  gas: string;
  gasPrice: string;
}

export interface SubmitResult {
  success: boolean;
  txHash?: string;
  blockHeight?: number;
  error?: string;
  timestamp: string;
}

/**
 * Submit approved proposal to Regen chain.
 *
 * TODO: Implement actual submission via cosmjs + tendermint RPC.
 * For now, returns mock success for staging.
 */
export async function submitProposalToChain(
  proposal: Proposal,
  config: RegenChainConfig,
  logger: Logger
): Promise<SubmitResult> {
  try {
    // Validate proposal
    if (!proposal) {
      return {
        success: false,
        error: "Proposal is empty",
        timestamp: new Date().toISOString(),
      };
    }

    logger.info({ proposal_type: proposal.type }, "Submitting proposal to Regen chain");

    // TODO: Build cosmjs-based submission
    // For now, mock the submission:
    const txHash = `0x${Math.random().toString(16).slice(2)}`;
    const blockHeight = Math.floor(Math.random() * 1_000_000) + 1;

    return {
      success: true,
      txHash,
      blockHeight,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error: errorMsg, proposal_type: proposal.type }, "Proposal submission failed");

    return {
      success: false,
      error: errorMsg,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Format proposal for telegram notification.
 */
export function formatProposalForTelegram(proposal: Proposal): string {
  switch (proposal.type) {
    case "FreezeMarket":
      return (
        `🔒 *Freeze Market Proposal*\n` +
        `Market: ${proposal.market_id}\n` +
        `Z-Score: ${proposal.z_score}\n` +
        `Confidence: ${(proposal.confidence * 100).toFixed(1)}%\n` +
        `Reason: ${proposal.reason}`
      );
    case "EmergencyStop":
      return (
        `🛑 *Emergency Stop Proposal* [${proposal.severity.toUpperCase()}]\n` +
        `Entity: ${proposal.entity}\n` +
        `Reason: ${proposal.reason}`
      );
    case "ParameterChange":
      return (
        `⚙️ *Parameter Change Proposal*\n` +
        `Contract: ${proposal.contract_address}\n` +
        `Parameter: ${proposal.parameter}\n` +
        `Current: ${proposal.current_value} → Proposed: ${proposal.proposed_value}\n` +
        `Rationale: ${proposal.rationale}`
      );
    default:
      return "Unknown proposal type";
  }
}
