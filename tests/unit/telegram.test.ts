import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockConfig, createMockLogger, mockRegenPrice, mockAvailableCredits, mockCommunityGoals } from "../helpers/mocks.js";
import type { MarketAlert, MarketSnapshot } from "../../src/types.js";

// Mock the entire module
const mockSendMessage = vi.fn().mockResolvedValue({});

vi.mock("node-telegram-bot-api", () => {
  return {
    default: class MockTelegramBot {
      sendMessage = mockSendMessage;
      constructor() {}
    },
  };
});

// Import AFTER mock is set up
const { TelegramNotifier } = await import("../../src/notifiers/telegram.js");

function createTestAlert(severity: "INFO" | "WARNING" | "CRITICAL"): MarketAlert {
  return {
    id: `alert-${Date.now()}`,
    severity,
    title: `Test ${severity} Alert`,
    body: "Something happened in the market.",
    data: { price: 0.042, threshold: 0.05 },
    timestamp: new Date(),
    delta: "+5.2%",
    trend: "\u2191\u2191\u2193",
    explorerUrl: "https://app.regen.network/ecocredits",
    nextCheckMinutes: 60,
  };
}

describe("TelegramNotifier", () => {
  let notifier: InstanceType<typeof TelegramNotifier>;

  beforeEach(() => {
    mockSendMessage.mockClear();
    const config = createMockConfig({
      telegramBotToken: "test-token",
      telegramChatId: "-100123",
    });
    notifier = new TelegramNotifier(config, createMockLogger());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sendAlert INFO contains info emoji and title", async () => {
    await notifier.sendAlert(createTestAlert("INFO"));
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const msg = mockSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("\u2139\ufe0f");
    expect(msg).toContain("Test INFO Alert");
  });

  it("sendAlert WARNING contains warning emoji", async () => {
    await notifier.sendAlert(createTestAlert("WARNING"));
    const msg = mockSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("\u26a0\ufe0f");
  });

  it("sendAlert CRITICAL contains critical emoji", async () => {
    vi.useFakeTimers();
    await notifier.sendAlert(createTestAlert("CRITICAL"));
    const msg = mockSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("\ud83d\udea8");
  });

  it("CRITICAL alert sends twice with 60s gap", async () => {
    vi.useFakeTimers();
    await notifier.sendAlert(createTestAlert("CRITICAL"));
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    const repeat = mockSendMessage.mock.calls[1][1] as string;
    expect(repeat).toContain("[REPEAT]");
  });

  it("daily digest contains required fields", async () => {
    const snapshot: MarketSnapshot = {
      price: mockRegenPrice(),
      credits: mockAvailableCredits(),
      communityGoals: mockCommunityGoals(),
      lastPollAt: new Date().toISOString(),
      pollDurationMs: 1500,
    };

    await notifier.sendDigest(snapshot, 5, 86400);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const msg = mockSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain("REGEN Price");
    expect(msg).toContain("Credits Available");
    expect(msg).toContain("5");
    expect(msg).toContain("1d");
  });

  it("console fallback when no token — no throw", async () => {
    const config = createMockConfig({ telegramBotToken: undefined, telegramChatId: undefined });
    const fallback = new TelegramNotifier(config, createMockLogger());
    await expect(fallback.sendAlert(createTestAlert("WARNING"))).resolves.toBeUndefined();
  });

  it("Telegram API error does not crash", async () => {
    mockSendMessage.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    await expect(notifier.sendAlert(createTestAlert("INFO"))).resolves.toBeUndefined();
  });
});
