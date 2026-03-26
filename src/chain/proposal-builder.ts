import { LCDClient } from "./lcd-client.js";
import { AuditLog } from "./audit-log.js";
import type {
  AnomalyReport,
  AnomalyEvidence,
  FreezeProposal,
  ValidationResult,
  PriceSnapshot,
  Config,
} from "../types.js";
import type { Logger } from "../logger.js";

/**
 * Builds governance proposals to freeze suspicious sell orders.
 * Only constructs proposals — NEVER signs or broadcasts.
 *
 * From the AGENT-003 spec:
 *   authority_level: Layer 1-2
 *   can_propose: true (freeze orders)
 *   can_execute: false
 */
export class ProposalBuilder {
  private lcd: LCDClient;
  private audit: AuditLog;
  private config: Config;
  private logger: Logger;

  constructor(lcd: LCDClient, audit: AuditLog, config: Config, logger: Logger) {
    this.lcd = lcd;
    this.audit = audit;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Build a freeze proposal when z-score >= 3.5 (CRITICAL manipulation alert).
   * Returns the unsigned proposal object.
   */
  buildFreezeProposal(
    anomalyReport: AnomalyReport,
    priceHistory: PriceSnapshot[],
    affectedOrderIds: string[] = []
  ): FreezeProposal {
    const id = crypto.randomUUID();
    const now = new Date();

    const evidence: AnomalyEvidence = {
      currentPrice: anomalyReport.current_price,
      medianPrice: anomalyReport.median_price,
      zScore: anomalyReport.z_score,
      priceHistory: priceHistory.slice(-24),
      detectedAt: now.toISOString(),
    };

    const proposal: FreezeProposal = {
      id,
      title: `Freeze Suspicious Sell Orders — Z-Score ${anomalyReport.z_score.toFixed(2)}`,
      summary: this.buildSummary(anomalyReport, evidence),
      evidence,
      affectedSellOrderIds: affectedOrderIds,
      batchDenom: "detected-anomaly",
      zScore: anomalyReport.z_score,
      deposit: { denom: "uregen", amount: "10000000" }, // 10 REGEN
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.proposalExpiryMs).toISOString(),
      status: "pending",
    };

    this.audit.append("proposal_created", id, "agent", {
      z_score: anomalyReport.z_score,
      price: anomalyReport.current_price,
      affected_orders: affectedOrderIds.length,
    });

    this.logger.info(
      { proposalId: id, z_score: anomalyReport.z_score },
      "Freeze proposal built"
    );

    return proposal;
  }

  /** Render the proposal as human-readable markdown for review */
  buildProposalMarkdown(proposal: FreezeProposal): string {
    const priceChart = this.renderAsciiChart(proposal.evidence.priceHistory);

    return [
      `# Freeze Proposal: ${proposal.id}`,
      ``,
      `## Summary`,
      proposal.summary,
      ``,
      `## Evidence`,
      `- **Z-Score:** ${proposal.zScore.toFixed(2)} (threshold: 3.5)`,
      `- **Current Price:** $${proposal.evidence.currentPrice.toFixed(4)}`,
      `- **Median Price:** $${proposal.evidence.medianPrice.toFixed(4)}`,
      `- **Detected At:** ${proposal.evidence.detectedAt}`,
      ``,
      `## Price History (last ${proposal.evidence.priceHistory.length} polls)`,
      "```",
      priceChart,
      "```",
      ``,
      `## Affected Sell Orders`,
      proposal.affectedSellOrderIds.length > 0
        ? proposal.affectedSellOrderIds.map((id) => `- Order #${id}`).join("\n")
        : "- No specific orders identified (general market anomaly)",
      ``,
      `## Recommended Action`,
      `Submit governance proposal to freeze affected sell orders pending investigation.`,
      ``,
      `## Deposit`,
      `${parseInt(proposal.deposit.amount) / 1e6} REGEN (${proposal.deposit.amount} ${proposal.deposit.denom})`,
      ``,
      `---`,
      `**\u26a0\ufe0f WARNING: This proposal requires human review before submission.**`,
      `The agent has constructed this proposal but CANNOT submit it autonomously.`,
      `Review all evidence carefully before approving.`,
      ``,
      `Expires: ${proposal.expiresAt}`,
    ].join("\n");
  }

  /**
   * Validate a proposal before submission.
   * Reject if confidence < 0.85.
   */
  async validateProposal(proposal: FreezeProposal): Promise<ValidationResult> {
    const reasons: string[] = [];
    let confidence = 1.0;

    // Check z-score still above threshold
    if (proposal.zScore < 3.5) {
      reasons.push(`Z-score ${proposal.zScore} below threshold 3.5`);
      confidence -= 0.5;
    }

    // Check affected orders still exist on chain
    for (const orderId of proposal.affectedSellOrderIds) {
      const exists = await this.lcd.sellOrderExists(orderId);
      if (!exists) {
        reasons.push(`Sell order #${orderId} no longer exists on chain`);
        confidence -= 0.1;
      }
    }

    // Check proposal text is complete
    if (!proposal.title || !proposal.summary) {
      reasons.push("Proposal title or summary is empty");
      confidence -= 0.3;
    }

    // Check not expired
    if (new Date(proposal.expiresAt) < new Date()) {
      reasons.push("Proposal has expired");
      confidence = 0;
    }

    // Check evidence is present
    if (!proposal.evidence || proposal.evidence.priceHistory.length === 0) {
      reasons.push("No price history evidence");
      confidence -= 0.2;
    }

    confidence = Math.max(0, Math.min(1, confidence));
    const valid = confidence >= 0.85 && reasons.length === 0;

    this.audit.append("proposal_validated", proposal.id, "agent", {
      valid,
      confidence,
      reasons,
    });

    this.logger.info(
      { proposalId: proposal.id, valid, confidence, reasons },
      "Proposal validation complete"
    );

    return { valid, reasons, confidence };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private buildSummary(report: AnomalyReport, evidence: AnomalyEvidence): string {
    return [
      `Price anomaly detected with z-score ${report.z_score.toFixed(2)} (threshold: 3.5).`,
      `Current price: $${report.current_price.toFixed(4)}, rolling median: $${report.median_price.toFixed(4)}.`,
      `This represents a ${Math.abs(report.price_change_pct * 100).toFixed(1)}% deviation.`,
      `Based on ${evidence.priceHistory.length} data points collected over the monitoring window.`,
      `Requesting governance review and potential freeze of affected sell orders.`,
    ].join(" ");
  }

  private renderAsciiChart(history: PriceSnapshot[]): string {
    if (history.length === 0) return "  (no data)";
    const prices = history.map((h) => h.price_usd);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const height = 8;

    const lines: string[] = [];
    for (let row = height; row >= 0; row--) {
      const threshold = min + (range * row) / height;
      const label = threshold.toFixed(4).padStart(8);
      const bar = prices
        .map((p) => (p >= threshold ? "\u2588" : " "))
        .join("");
      lines.push(`${label} |${bar}`);
    }
    lines.push(`${"".padStart(8)} +${"─".repeat(prices.length)}`);
    return lines.join("\n");
  }
}
