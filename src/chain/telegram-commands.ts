import TelegramBot from "node-telegram-bot-api";
import { ApprovalGate } from "./approval-gate.js";
import type { FreezeProposal, Config } from "../types.js";
import type { Logger } from "../logger.js";

/**
 * Telegram command handler for proposal approval/rejection.
 * Listens for /approve <uuid> and /reject <uuid> commands.
 *
 * ONLY accepts commands from TELEGRAM_ADMIN_CHAT_ID — rejects all others silently.
 */
export class TelegramCommandHandler {
  private bot: TelegramBot;
  private gate: ApprovalGate;
  private config: Config;
  private logger: Logger;
  private adminChatId: string;

  constructor(bot: TelegramBot, gate: ApprovalGate, config: Config, logger: Logger) {
    this.bot = bot;
    this.gate = gate;
    this.config = config;
    this.logger = logger;
    this.adminChatId = config.telegramAdminChatId || "";
  }

  /** Start listening for commands */
  start(): void {
    if (!this.adminChatId) {
      this.logger.warn("TELEGRAM_ADMIN_CHAT_ID not set — proposal commands disabled");
      return;
    }

    this.bot.on("message", (msg) => {
      if (!msg.text) return;

      // ONLY accept commands from admin chat
      if (String(msg.chat.id) !== this.adminChatId) return;

      const text = msg.text.trim();

      if (text.startsWith("/approve ")) {
        const uuid = text.slice("/approve ".length).trim();
        this.handleApprove(uuid, msg.chat.id);
      } else if (text.startsWith("/reject ")) {
        const parts = text.slice("/reject ".length).trim();
        const spaceIdx = parts.indexOf(" ");
        const uuid = spaceIdx > 0 ? parts.slice(0, spaceIdx) : parts;
        const reason = spaceIdx > 0 ? parts.slice(spaceIdx + 1).trim() : undefined;
        this.handleReject(uuid, reason, msg.chat.id);
      } else if (text === "/pending") {
        this.handleListPending(msg.chat.id);
      }
    });

    this.logger.info(
      { admin_chat_id: this.adminChatId },
      "Telegram command handler started"
    );
  }

  /** Send the approval request notification */
  async sendApprovalRequest(proposal: FreezeProposal, _markdown: string): Promise<void> {
    const chatId = this.config.telegramChatId || this.adminChatId;
    if (!chatId) return;

    const message = [
      `\ud83d\udd34 <b>FREEZE PROPOSAL REQUIRES YOUR APPROVAL</b>`,
      ``,
      `<b>Proposal:</b> <code>${proposal.id}</code>`,
      `<b>Z-Score:</b> ${proposal.zScore.toFixed(2)} (threshold: 3.5)`,
      `<b>Price:</b> $${proposal.evidence.currentPrice.toFixed(4)} (median: $${proposal.evidence.medianPrice.toFixed(4)})`,
      `<b>Affected Orders:</b> ${proposal.affectedSellOrderIds.length || "general anomaly"}`,
      `<b>Deposit:</b> ${parseInt(proposal.deposit.amount) / 1e6} REGEN`,
      `<b>Expires:</b> ${proposal.expiresAt}`,
      ``,
      `<b>${proposal.summary}</b>`,
      ``,
      `\u2705 Reply <code>/approve ${proposal.id}</code> to submit to Regen governance`,
      `\u274c Reply <code>/reject ${proposal.id}</code> with optional reason to discard`,
      ``,
      `<i>\u26a0\ufe0f This proposal will auto-expire and be discarded if not acted upon.</i>`,
    ].join("\n");

    try {
      await this.bot.sendMessage(chatId, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (err) {
      this.logger.error({ err, proposalId: proposal.id }, "Failed to send approval request");
    }
  }

  // ─── Command Handlers ─────────────────────────────────────────────

  private async handleApprove(uuid: string, chatId: number): Promise<void> {
    this.logger.info({ proposalId: uuid }, "Human /approve command received");

    try {
      await this.bot.sendMessage(chatId, `\u23f3 Processing approval for <code>${uuid}</code>...`, { parse_mode: "HTML" });

      const result = await this.gate.approve(uuid);

      if (result.success) {
        await this.bot.sendMessage(
          chatId,
          `\u2705 <b>Proposal submitted successfully!</b>\n\nTx Hash: <code>${result.txHash}</code>\n\nhttps://www.mintscan.io/regen/tx/${result.txHash}`,
          { parse_mode: "HTML", disable_web_page_preview: true }
        );
      } else {
        await this.bot.sendMessage(
          chatId,
          `\u274c <b>Approval failed:</b> ${result.error}`,
          { parse_mode: "HTML" }
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.bot.sendMessage(chatId, `\u274c Error: ${errMsg}`).catch(() => {});
      this.logger.error({ err, proposalId: uuid }, "Approve command failed");
    }
  }

  private async handleReject(uuid: string, reason: string | undefined, chatId: number): Promise<void> {
    this.logger.info({ proposalId: uuid, reason }, "Human /reject command received");

    const result = this.gate.reject(uuid, reason);

    if (result.success) {
      await this.bot.sendMessage(
        chatId,
        `\u2705 Proposal <code>${uuid}</code> rejected.${reason ? `\nReason: ${reason}` : ""}`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    } else {
      await this.bot.sendMessage(
        chatId,
        `\u274c ${result.error}`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
  }

  private async handleListPending(chatId: number): Promise<void> {
    const pending = this.gate.listPending();

    if (pending.length === 0) {
      await this.bot.sendMessage(chatId, "No pending proposals.").catch(() => {});
      return;
    }

    const lines = pending.map(
      (p) => `\u2022 <code>${p.id}</code> — z=${p.zScore.toFixed(2)}, expires ${p.expiresAt}`
    );

    await this.bot.sendMessage(
      chatId,
      `<b>Pending Proposals (${pending.length}):</b>\n\n${lines.join("\n")}`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  }
}
