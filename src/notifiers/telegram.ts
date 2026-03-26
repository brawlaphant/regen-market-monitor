import TelegramBot from "node-telegram-bot-api";
import type { MarketAlert, MarketSnapshot, Config } from "../types.js";
import type { Logger } from "../logger.js";

const SEVERITY_EMOJI: Record<string, string> = {
  INFO: "\u2139\ufe0f",
  WARNING: "\u26a0\ufe0f",
  CRITICAL: "\ud83d\udea8",
};

/**
 * Telegram notifier with:
 * - Richer alert messages with delta, trend, explorer links, next-check footer (#11)
 * - Critical escalation: CRITICAL alerts sent twice with 60s gap (#13)
 * - Daily digest at configured UTC hour (#12)
 * - Console fallback when Telegram not configured
 */
export class TelegramNotifier {
  private bot: TelegramBot | null = null;
  private chatId: string | null = null;
  private logger: Logger;
  private useFallback: boolean;

  constructor(config: Config, logger: Logger) {
    this.logger = logger;

    if (config.telegramBotToken && config.telegramChatId) {
      this.bot = new TelegramBot(config.telegramBotToken, { polling: false });
      this.chatId = config.telegramChatId;
      this.useFallback = false;
      this.logger.info("Telegram notifier configured");
    } else {
      this.useFallback = true;
      this.logger.warn(
        "Telegram not configured — alerts will log to console only"
      );
    }
  }

  /** Send a formatted alert. CRITICAL alerts get sent twice with 60s gap (#13). */
  async sendAlert(alert: MarketAlert): Promise<void> {
    const message = this.formatAlert(alert);
    await this.send(message);

    // Critical escalation (#13)
    if (alert.severity === "CRITICAL") {
      this.logger.info({ alert_id: alert.id }, "Critical escalation: resending in 60s");
      setTimeout(async () => {
        const repeat = `\ud83d\udea8 <b>[REPEAT] ${alert.title}</b>\n\n` +
          `This is a repeated critical alert. Original sent 60s ago.\n\n` +
          message;
        await this.send(repeat);
      }, 60_000);
    }
  }

  /** Send the daily digest (#12) */
  async sendDigest(
    snapshot: MarketSnapshot | null,
    alertsFiredToday: number,
    uptimeSeconds: number
  ): Promise<void> {
    const lines: string[] = [
      `\ud83d\udcca <b>Daily Market Digest</b>`,
      ``,
    ];

    if (snapshot?.price) {
      lines.push(
        `<b>REGEN Price:</b> $${snapshot.price.price_usd.toFixed(4)} (${snapshot.price.change_24h >= 0 ? "+" : ""}${snapshot.price.change_24h.toFixed(2)}% 24h)`
      );
    } else {
      lines.push(`<b>REGEN Price:</b> unavailable`);
    }

    if (snapshot?.credits) {
      lines.push(
        `<b>Credits Available:</b> ${snapshot.credits.total_tradable.toLocaleString()} across ${snapshot.credits.credits.length} batches`
      );
      lines.push(
        `<b>Listed Value:</b> $${snapshot.credits.total_listed_value_usd.toLocaleString()}`
      );
    }

    if (snapshot?.communityGoals?.goals?.length) {
      lines.push(``, `<b>Community Goals:</b>`);
      for (const goal of snapshot.communityGoals.goals) {
        const bar = progressBar(goal.percent_complete);
        lines.push(`  ${bar} ${goal.name} (${goal.percent_complete.toFixed(0)}%)`);
      }
    }

    lines.push(``);
    lines.push(`<b>Alerts fired (24h):</b> ${alertsFiredToday}`);
    lines.push(`<b>Agent uptime:</b> ${formatUptime(uptimeSeconds)}`);
    lines.push(``);
    lines.push(`<i>${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC \u2014 RegenMarketMonitor</i>`);

    await this.send(lines.join("\n"));
  }

  private async send(message: string): Promise<void> {
    if (this.useFallback || !this.bot || !this.chatId) {
      // Strip HTML tags for console readability
      const plain = message.replace(/<[^>]+>/g, "");
      this.logger.info({ telegram_fallback: true }, plain);
      return;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      this.logger.debug("Telegram message sent");
    } catch (err) {
      this.logger.error({ err }, "Telegram send failed");
      const plain = message.replace(/<[^>]+>/g, "");
      this.logger.info({ telegram_fallback: true }, plain);
    }
  }

  /** Format an alert with enriched fields (#11) */
  private formatAlert(alert: MarketAlert): string {
    const emoji = SEVERITY_EMOJI[alert.severity] || "";
    const time = alert.timestamp.toISOString().replace("T", " ").slice(0, 19);

    const dataLines = Object.entries(alert.data)
      .filter(([k]) => k !== "threshold")
      .map(([k, v]) => `  ${k}: ${typeof v === "number" ? formatNum(v) : v}`)
      .join("\n");

    const parts: string[] = [
      `${emoji} <b>[${alert.severity}] ${alert.title}</b>`,
      ``,
      alert.body,
    ];

    // Delta from last poll (#11)
    if (alert.delta) {
      parts.push(`\u0394 ${alert.delta}`);
    }

    // Trend indicator (#11)
    if (alert.trend) {
      parts.push(`Trend: ${alert.trend}`);
    }

    parts.push(``, `<pre>${dataLines}</pre>`);

    // Explorer link (#11)
    if (alert.explorerUrl) {
      parts.push(``, `\ud83d\udd17 <a href="${alert.explorerUrl}">View on Regen Network</a>`);
    }

    // Next check footer (#11)
    if (alert.nextCheckMinutes) {
      parts.push(`\u23f0 Next check in ${alert.nextCheckMinutes} minutes`);
    }

    parts.push(``, `<i>${time} UTC \u2014 RegenMarketMonitor</i>`);

    return parts.join("\n");
  }
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(4);
}

function progressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
