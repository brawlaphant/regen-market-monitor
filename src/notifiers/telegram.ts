import TelegramBot from "node-telegram-bot-api";
import type { MarketAlert, Config } from "../types.js";
import type { Logger } from "../logger.js";

const SEVERITY_EMOJI: Record<string, string> = {
  INFO: "\u2139\ufe0f",
  WARNING: "\u26a0\ufe0f",
  CRITICAL: "\ud83d\udea8",
};

/**
 * Telegram notifier for market alerts.
 * Falls back to console.log if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set.
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

  /** Send a formatted alert to Telegram or console */
  async sendAlert(alert: MarketAlert): Promise<void> {
    const message = this.format(alert);

    if (this.useFallback || !this.bot || !this.chatId) {
      console.log("\n" + message + "\n");
      return;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: "HTML",
      });
      this.logger.debug({ alert_id: alert.id }, "Telegram message sent");
    } catch (err) {
      this.logger.error({ err, alert_id: alert.id }, "Telegram send failed");
      // Fall back to console so the alert is never lost
      console.log("\n" + message + "\n");
    }
  }

  /** Format an alert as a Telegram-friendly HTML message */
  private format(alert: MarketAlert): string {
    const emoji = SEVERITY_EMOJI[alert.severity] || "";
    const time = alert.timestamp.toISOString().replace("T", " ").slice(0, 19);
    const dataLines = Object.entries(alert.data)
      .map(([k, v]) => `  ${k}: ${typeof v === "number" ? formatNum(v) : v}`)
      .join("\n");

    return [
      `${emoji} <b>[${alert.severity}] ${alert.title}</b>`,
      ``,
      alert.body,
      ``,
      `<pre>${dataLines}</pre>`,
      ``,
      `<i>${time} UTC — RegenMarketMonitor</i>`,
    ].join("\n");
  }
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(4);
}
