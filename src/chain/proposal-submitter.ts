import { SigningStargateClient, GasPrice } from "@cosmjs/stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import type { EncodeObject } from "@cosmjs/proto-signing";
import { AuditLog } from "./audit-log.js";
import type { FreezeProposal, SubmissionResult, DryRunResult, Config } from "../types.js";
import type { Logger } from "../logger.js";

const TX_POLL_INTERVAL_MS = 3000;
const TX_POLL_TIMEOUT_MS = 60000;

/**
 * The ONLY component that touches the chain.
 * Only called by ApprovalGate AFTER explicit human /approve command.
 *
 * REGEN_MNEMONIC must NEVER appear in any log, error, or audit entry.
 */
export class ProposalSubmitter {
  private config: Config;
  private logger: Logger;
  private audit: AuditLog;
  private wallet: DirectSecp256k1HdWallet | null = null;
  private senderAddress: string | null = null;

  constructor(config: Config, audit: AuditLog, logger: Logger) {
    this.config = config;
    this.audit = audit;
    this.logger = logger;
  }

  /** Initialize the wallet from mnemonic. Call once at startup. */
  async init(): Promise<void> {
    if (!this.config.regenMnemonic) {
      throw new Error(
        "REGEN_MNEMONIC is required for proposal submission. " +
        "Set it in .env. The agent cannot submit governance proposals without it."
      );
    }

    this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(
      this.config.regenMnemonic,
      { prefix: "regen" }
    );
    const [account] = await this.wallet.getAccounts();
    this.senderAddress = account.address;
    this.logger.info(
      { address: this.senderAddress },
      "ProposalSubmitter wallet initialized"
    );
  }

  /**
   * Submit an approved freeze proposal to Regen governance.
   * On failure: does NOT retry — logs error and notifies Telegram.
   */
  async submitProposal(proposal: FreezeProposal): Promise<SubmissionResult> {
    if (!this.wallet || !this.senderAddress) {
      return { success: false, error: "Wallet not initialized" };
    }

    try {
      const client = await SigningStargateClient.connectWithSigner(
        this.config.regenRpcUrl,
        this.wallet,
        { gasPrice: GasPrice.fromString(this.config.regenGasPrice) }
      );

      const msg = this.buildMsg(proposal);

      // Simulate gas first
      const gasEstimate = await client.simulate(this.senderAddress, [msg], "");
      const gasLimit = Math.ceil(gasEstimate * this.config.gasMultiplier);

      this.logger.info(
        { proposalId: proposal.id, estimatedGas: gasEstimate, gasLimit },
        "Gas simulation complete"
      );

      // Broadcast
      const result = await client.signAndBroadcast(
        this.senderAddress,
        [msg],
        {
          amount: [{ denom: "uregen", amount: String(Math.ceil(gasLimit * 0.015)) }],
          gas: String(gasLimit),
        },
        `AGENT-003 freeze proposal: ${proposal.id}`
      );

      if (result.code !== 0) {
        const errMsg = `Tx failed with code ${result.code}: ${result.rawLog}`;
        this.audit.append("submission_failed", proposal.id, "agent", {
          code: result.code,
          rawLog: result.rawLog?.slice(0, 500),
        });
        this.logger.error({ proposalId: proposal.id, code: result.code }, errMsg);
        return { success: false, error: errMsg };
      }

      const submission: SubmissionResult = {
        success: true,
        txHash: result.transactionHash,
        blockHeight: result.height,
        gasUsed: Number(result.gasUsed),
      };

      this.audit.append("submitted", proposal.id, "agent", {
        txHash: result.transactionHash,
        blockHeight: result.height,
        gasUsed: Number(result.gasUsed),
      });

      this.logger.info(
        { proposalId: proposal.id, txHash: result.transactionHash, height: result.height },
        "Proposal submitted to chain"
      );

      client.disconnect();
      return submission;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // NEVER log mnemonic-related details
      const safeMsg = errMsg.replace(/\b\w+(\s+\w+){11,}\b/g, "[REDACTED]");

      this.audit.append("submission_failed", proposal.id, "agent", {
        error: safeMsg.slice(0, 500),
      });

      this.logger.error(
        { proposalId: proposal.id, error: safeMsg },
        "Proposal submission failed"
      );

      return { success: false, error: safeMsg };
    }
  }

  /**
   * Simulate the proposal transaction without broadcasting.
   * Used during validateProposal to confirm the tx would succeed.
   */
  async submitProposalDryRun(proposal: FreezeProposal): Promise<DryRunResult> {
    if (!this.wallet || !this.senderAddress) {
      return { success: false, error: "Wallet not initialized" };
    }

    try {
      const client = await SigningStargateClient.connectWithSigner(
        this.config.regenRpcUrl,
        this.wallet,
        { gasPrice: GasPrice.fromString(this.config.regenGasPrice) }
      );

      const msg = this.buildMsg(proposal);
      const gasEstimate = await client.simulate(this.senderAddress, [msg], "");
      const gasLimit = Math.ceil(gasEstimate * this.config.gasMultiplier);
      const fee = Math.ceil(gasLimit * 0.015);

      client.disconnect();

      const result: DryRunResult = {
        success: true,
        estimatedGas: gasEstimate,
        estimatedFee: `${fee}uregen`,
      };

      this.audit.append("dry_run_completed", proposal.id, "agent", {
        estimatedGas: gasEstimate,
        estimatedFee: `${fee}uregen`,
      });

      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const safeMsg = errMsg.replace(/\b\w+(\s+\w+){11,}\b/g, "[REDACTED]");
      return { success: false, error: safeMsg };
    }
  }

  /** Construct the MsgSubmitProposal EncodeObject */
  private buildMsg(proposal: FreezeProposal): EncodeObject {
    // Encode TextProposal content using manual protobuf encoding
    const textProposalBytes = encodeTextProposal(
      proposal.title,
      proposal.summary
    );

    return {
      typeUrl: "/cosmos.gov.v1beta1.MsgSubmitProposal",
      value: {
        content: {
          typeUrl: "/cosmos.gov.v1beta1.TextProposal",
          value: textProposalBytes,
        },
        proposer: this.senderAddress,
        initialDeposit: [
          { denom: proposal.deposit.denom, amount: proposal.deposit.amount },
        ],
      },
    };
  }
}

/**
 * Manual protobuf encoding for TextProposal { title, description }.
 * Avoids dependency on cosmjs-types ESM compatibility issues.
 *
 * Wire format:
 *  field 1 (title):       tag=0x0A, length-delimited string
 *  field 2 (description): tag=0x12, length-delimited string
 */
function encodeTextProposal(title: string, description: string): Uint8Array {
  const enc = new TextEncoder();
  const titleBytes = enc.encode(title);
  const descBytes = enc.encode(description);

  const parts: number[] = [];
  // Field 1: title
  parts.push(0x0a);
  pushVarint(parts, titleBytes.length);
  for (const b of titleBytes) parts.push(b);
  // Field 2: description
  parts.push(0x12);
  pushVarint(parts, descBytes.length);
  for (const b of descBytes) parts.push(b);

  return new Uint8Array(parts);
}

function pushVarint(arr: number[], value: number): void {
  let v = value;
  while (v > 0x7f) {
    arr.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  arr.push(v & 0x7f);
}
