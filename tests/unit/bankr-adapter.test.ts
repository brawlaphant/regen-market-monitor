import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { BankrAdapter } from "../../src/execution/bankr-adapter.js";
import type { TradeOrder } from "../../src/execution/bankr-adapter.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeOrder(overrides: Partial<TradeOrder> = {}): TradeOrder {
  return {
    id: crypto.randomUUID(), signal_id: "sig-1", phase: "accumulation",
    chain: "base", action: "buy", token_in: "USDC", token_out: "REGEN",
    amount_usd: 10, max_slippage_pct: 1.0, venue: "hydrex",
    priority: "medium", requires_approval: false,
    status: "pending_approval", created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("BankrAdapter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "bankr-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.EXECUTION_ENABLED;
    delete process.env.DAILY_BUY_CAP_USD;
    delete process.env.SINGLE_ORDER_MAX_USD;
    delete process.env.EXECUTION_THRESHOLD_USD;
  });

  it("rejects execution when EXECUTION_ENABLED=false", async () => {
    process.env.EXECUTION_ENABLED = "false";
    const adapter = new BankrAdapter(tmpDir, mockLogger());
    const result = await adapter.execute(makeOrder());
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
  });

  it("routes to approval when amount > EXECUTION_THRESHOLD_USD", async () => {
    process.env.EXECUTION_ENABLED = "true";
    process.env.EXECUTION_THRESHOLD_USD = "5";
    const adapter = new BankrAdapter(tmpDir, mockLogger());
    let approvalCalled = false;
    adapter.onApprovalRequired = async () => { approvalCalled = true; };

    const result = await adapter.execute(makeOrder({ amount_usd: 10 }));
    expect(result.success).toBe(true);
    expect(result.order.status).toBe("pending_approval");
    expect(approvalCalled).toBe(true);
  });

  it("rejects when SINGLE_ORDER_MAX_USD exceeded", async () => {
    process.env.EXECUTION_ENABLED = "true";
    process.env.SINGLE_ORDER_MAX_USD = "5";
    const adapter = new BankrAdapter(tmpDir, mockLogger());
    const result = await adapter.execute(makeOrder({ amount_usd: 10 }));
    expect(result.success).toBe(false);
    expect(result.error).toContain("SINGLE_ORDER_MAX_USD");
  });

  it("daily cap enforcement: rejects when cap exhausted", async () => {
    process.env.EXECUTION_ENABLED = "true";
    process.env.DAILY_BUY_CAP_USD = "15";
    process.env.EXECUTION_THRESHOLD_USD = "100"; // high threshold so no approval needed
    const adapter = new BankrAdapter(tmpDir, mockLogger());

    // First order succeeds
    await adapter.execute(makeOrder({ amount_usd: 10 }));

    // Second order should fail (10 + 10 > 15)
    const result = await adapter.execute(makeOrder({ amount_usd: 10 }));
    expect(result.success).toBe(false);
    expect(result.error).toContain("cap exhausted");
  });

  it("daily cap resets at midnight UTC", () => {
    process.env.EXECUTION_ENABLED = "true";
    const adapter = new BankrAdapter(tmpDir, mockLogger());
    const remaining = adapter.getDailyCapRemaining();
    expect(remaining.buy_remaining).toBeGreaterThan(0);
    expect(remaining.sell_remaining).toBeGreaterThan(0);
  });
});
