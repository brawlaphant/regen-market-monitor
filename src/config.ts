import { Config } from "./types.js";

export function loadConfig(): Config {
  const url = process.env.REGEN_COMPUTE_MCP_URL;
  if (!url) {
    throw new Error(
      "REGEN_COMPUTE_MCP_URL is required. Set it in .env or environment."
    );
  }

  return {
    regenComputeMcpUrl: url,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "3600000", 10),
    lowStockThreshold: parseInt(process.env.LOW_STOCK_THRESHOLD || "1000", 10),
    priceMoveThreshold: parseFloat(process.env.PRICE_MOVE_THRESHOLD || "0.10"),
    alertCooldownMs: parseInt(process.env.ALERT_COOLDOWN_MS || "3600000", 10),
    logLevel: process.env.LOG_LEVEL || "info",
    port: parseInt(process.env.PORT || "3099", 10),
    dailyDigestHourUtc: parseInt(process.env.DAILY_DIGEST_HOUR_UTC || "9", 10),
    dataDir: process.env.DATA_DIR || "./data",
    mcpTimeoutMs: parseInt(process.env.MCP_TIMEOUT_MS || "10000", 10),
    mcpRetryAttempts: parseInt(process.env.MCP_RETRY_ATTEMPTS || "3", 10),
    // Chain config
    regenLcdUrl: process.env.REGEN_LCD_URL || "https://regen.api.boz.moe",
    regenRpcUrl: process.env.REGEN_RPC_URL || "https://regen-rpc.polkachu.com",
    regenMnemonic: process.env.REGEN_MNEMONIC || undefined,
    regenChainId: process.env.REGEN_CHAIN_ID || "regen-1",
    regenGasPrice: process.env.REGEN_GAS_PRICE || "0.015uregen",
    gasMultiplier: parseFloat(process.env.GAS_MULTIPLIER || "1.3"),
    eventPollIntervalMs: parseInt(process.env.EVENT_POLL_INTERVAL_MS || "60000", 10),
    largeTradeThresholdUsd: parseFloat(process.env.LARGE_TRADE_THRESHOLD_USD || "10000"),
    proposalExpiryMs: parseInt(process.env.PROPOSAL_EXPIRY_MS || "3600000", 10),
    telegramAdminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || undefined,
  };
}
