import fs from "node:fs";
import path from "node:path";
import { ProposalBuilder } from "./proposal-builder.js";
import { ProposalSubmitter } from "./proposal-submitter.js";
import { AuditLog } from "./audit-log.js";
import type { FreezeProposal, Config } from "../types.js";
import type { Logger } from "../logger.js";

/**
 * Every on-chain proposal MUST pass through a human approval gate
 * before any submission. This is NON-NEGOTIABLE per the spec (can_execute: false).
 *
 * - No exceptions, no bypasses, no timeouts that auto-approve
 * - The agent NEVER submits without explicit human /approve command
 */
export class ApprovalGate {
  private config: Config;
  private logger: Logger;
  private audit: AuditLog;
  private builder: ProposalBuilder;
  private submitter: ProposalSubmitter;
  private pendingDir: string;
  /** Callback to send approval request via Telegram */
  private notifyFn: ((proposal: FreezeProposal, markdown: string) => Promise<void>) | null = null;

  constructor(
    config: Config,
    builder: ProposalBuilder,
    submitter: ProposalSubmitter,
    audit: AuditLog,
    logger: Logger
  ) {
    this.config = config;
    this.builder = builder;
    this.submitter = submitter;
    this.audit = audit;
    this.logger = logger;
    this.pendingDir = path.join(config.dataDir, "pending-proposals");

    if (!fs.existsSync(this.pendingDir)) {
      fs.mkdirSync(this.pendingDir, { recursive: true });
    }

    // Auto-reject expired proposals on startup
    this.cleanupExpired();
  }

  /** Register the notification function (called from index.ts with Telegram) */
  onNotify(fn: (proposal: FreezeProposal, markdown: string) => Promise<void>): void {
    this.notifyFn = fn;
  }

  /**
   * Request human approval for a freeze proposal.
   * Stores proposal to disk and sends Telegram notification.
   */
  async requestApproval(proposal: FreezeProposal): Promise<void> {
    // Save to disk
    const filePath = path.join(this.pendingDir, `${proposal.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2), "utf-8");

    this.audit.append("approval_requested", proposal.id, "agent", {
      z_score: proposal.zScore,
      expires_at: proposal.expiresAt,
    });

    // Build markdown for review
    const markdown = this.builder.buildProposalMarkdown(proposal);

    // Notify via Telegram
    if (this.notifyFn) {
      await this.notifyFn(proposal, markdown);
    }

    this.logger.info(
      { proposalId: proposal.id, expiresAt: proposal.expiresAt },
      "Approval requested — waiting for human /approve or /reject"
    );
  }

  /** Handle /approve command from human */
  async approve(proposalId: string): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const proposal = this.loadProposal(proposalId);
    if (!proposal) return { success: false, error: "Proposal not found" };

    if (proposal.status !== "pending") {
      return { success: false, error: `Proposal status is '${proposal.status}', not 'pending'` };
    }

    if (new Date(proposal.expiresAt) < new Date()) {
      this.rejectProposal(proposal, "Expired before approval");
      return { success: false, error: "Proposal has expired" };
    }

    // Re-validate before submission
    const validation = await this.builder.validateProposal(proposal);
    if (!validation.valid) {
      this.rejectProposal(proposal, `Re-validation failed: ${validation.reasons.join(", ")}`);
      return { success: false, error: `Validation failed: ${validation.reasons.join(", ")}` };
    }

    // Submit to chain
    this.audit.append("approved", proposalId, "human", {});
    proposal.status = "approved";
    this.saveProposal(proposal);

    const result = await this.submitter.submitProposal(proposal);

    if (result.success) {
      proposal.status = "submitted";
      proposal.txHash = result.txHash;
      this.saveProposal(proposal);
      return { success: true, txHash: result.txHash };
    } else {
      proposal.status = "failed";
      this.saveProposal(proposal);
      return { success: false, error: result.error };
    }
  }

  /** Handle /reject command from human */
  reject(proposalId: string, reason?: string): { success: boolean; error?: string } {
    const proposal = this.loadProposal(proposalId);
    if (!proposal) return { success: false, error: "Proposal not found" };

    this.rejectProposal(proposal, reason || "Rejected by operator");
    return { success: true };
  }

  /** List all pending proposals */
  listPending(): FreezeProposal[] {
    try {
      const files = fs.readdirSync(this.pendingDir).filter((f) => f.endsWith(".json"));
      return files
        .map((f) => {
          try {
            const raw = fs.readFileSync(path.join(this.pendingDir, f), "utf-8");
            return JSON.parse(raw) as FreezeProposal;
          } catch {
            return null;
          }
        })
        .filter((p): p is FreezeProposal => p !== null && p.status === "pending");
    } catch {
      return [];
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private loadProposal(id: string): FreezeProposal | null {
    const filePath = path.join(this.pendingDir, `${id}.json`);
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as FreezeProposal;
    } catch {
      return null;
    }
  }

  private saveProposal(proposal: FreezeProposal): void {
    const filePath = path.join(this.pendingDir, `${proposal.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2), "utf-8");
  }

  private rejectProposal(proposal: FreezeProposal, reason: string): void {
    proposal.status = "rejected";
    proposal.rejectionReason = reason;
    this.saveProposal(proposal);
    this.audit.append("rejected", proposal.id, proposal.rejectionReason?.includes("operator") ? "human" : "agent", {
      reason,
    });
    this.logger.info({ proposalId: proposal.id, reason }, "Proposal rejected");
  }

  private cleanupExpired(): void {
    const pending = this.listPending();
    const now = new Date();
    let expired = 0;

    for (const proposal of pending) {
      if (new Date(proposal.expiresAt) < now) {
        proposal.status = "expired";
        this.saveProposal(proposal);
        this.audit.append("expired", proposal.id, "agent", {
          expired_at: now.toISOString(),
        });
        expired++;
      }
    }

    if (expired > 0) {
      this.logger.info({ expired_count: expired }, "Cleaned up expired proposals on startup");
    }
  }
}
