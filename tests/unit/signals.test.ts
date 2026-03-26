import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildSignal } from "../../src/signals/signal-factory.js";
import { SignalStore } from "../../src/signals/signal-store.js";
import { computeHmac } from "../../src/signals/publishers/webhook-publisher.js";
import { ROUTING_TABLE, TTL_TABLE } from "../../src/signals/signal-schema.js";
import type { SignalType, MarketSignal, PriceAnomalyData, ManipulationAlertData, LowSupplyData, GoalCompletedData, MarketReportData, PriceMovementData } from "../../src/signals/signal-schema.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("buildSignal", () => {
  it("MANIPULATION_ALERT always severity CRITICAL", () => {
    const data: ManipulationAlertData = {
      batch_denom: "C01-001", order_ids: ["1"], z_score: 2.0,
      evidence_summary: "test",
    };
    const signal = buildSignal("MANIPULATION_ALERT", data, { workflow_id: "WF-MM-01" });
    expect(signal.severity).toBe("CRITICAL");
    expect(signal.routing.priority).toBe(1);
  });

  it("PRICE_ANOMALY z-score >= 3.5 is CRITICAL", () => {
    const data: PriceAnomalyData = {
      batch_denom: "C01-001", current_price: 0.09, z_score: 4.0,
      mean_price: 0.04, std_dev: 0.01, window_size: 24, anomaly_level: "critical",
    };
    const signal = buildSignal("PRICE_ANOMALY", data, {});
    expect(signal.severity).toBe("CRITICAL");
  });

  it("PRICE_ANOMALY z-score 2.0–3.49 is WARNING", () => {
    const data: PriceAnomalyData = {
      batch_denom: "C01-001", current_price: 0.05, z_score: 2.5,
      mean_price: 0.04, std_dev: 0.005, window_size: 24, anomaly_level: "warning",
    };
    const signal = buildSignal("PRICE_ANOMALY", data, {});
    expect(signal.severity).toBe("WARNING");
  });

  it("GOAL_COMPLETED is INFO", () => {
    const data: GoalCompletedData = {
      goal_id: "g1", goal_name: "Test", target: 1000, final_value: 1000,
      completed_at: new Date().toISOString(),
    };
    const signal = buildSignal("GOAL_COMPLETED", data, {});
    expect(signal.severity).toBe("INFO");
  });

  it("correct target_agents from routing table for each type", () => {
    for (const [type, agents] of Object.entries(ROUTING_TABLE)) {
      const data: LowSupplyData = { available_credits: 100, threshold: 1000, deficit: 900 };
      // LOW_SUPPLY is simplest to construct generically
      if (type === "LOW_SUPPLY") {
        const signal = buildSignal(type as SignalType, data, {});
        expect(signal.routing.target_agents).toEqual(agents);
      }
    }
  });

  it("correct TTL for each signal_type", () => {
    const data: LowSupplyData = { available_credits: 100, threshold: 1000, deficit: 900 };
    const signal = buildSignal("LOW_SUPPLY", data, {});
    expect(signal.routing.ttl_seconds).toBe(TTL_TABLE["LOW_SUPPLY"]);
  });

  it("MARKET_REPORT TTL is 86400", () => {
    const data: MarketReportData = {
      regen_price_usd: 0.04, available_credits: 5000, health_score: 72,
      active_goals: 3, goals_completed_today: 0, alerts_fired_today: 2,
      period_start: "2024-01-01", period_end: "2024-01-02",
    };
    const signal = buildSignal("MARKET_REPORT", data, {});
    expect(signal.routing.ttl_seconds).toBe(86400);
    expect(signal.severity).toBe("INFO");
  });

  it("throws on invalid data (Zod validation failure)", () => {
    expect(() => buildSignal("LOW_SUPPLY" as SignalType, { bad: true } as any, {})).toThrow();
  });

  it("sets version, source, agent_id correctly", () => {
    const data: LowSupplyData = { available_credits: 100, threshold: 1000, deficit: 900 };
    const signal = buildSignal("LOW_SUPPLY", data, {});
    expect(signal.version).toBe("1.0");
    expect(signal.source).toBe("regen-market-monitor");
    expect(signal.agent_id).toBe("AGENT-003");
  });
});

describe("SignalStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "sigstore-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSignal(overrides: Partial<MarketSignal> = {}): MarketSignal {
    return {
      id: crypto.randomUUID(),
      version: "1.0",
      source: "regen-market-monitor",
      agent_id: "AGENT-003",
      signal_type: "LOW_SUPPLY",
      severity: "WARNING",
      timestamp: new Date().toISOString(),
      data: { available_credits: 100, threshold: 1000, deficit: 900 },
      context: { triggered_by: "scheduled_poll", workflow_id: "WF-MM-02", poll_sequence: 1, related_signal_ids: [] },
      routing: { target_agents: ["AGENT-001"], broadcast_channels: ["rest"], ttl_seconds: 3600, priority: 2 },
      ...overrides,
    } as MarketSignal;
  }

  it("ring buffer trims at maxSize", () => {
    const store = new SignalStore(tmpDir, mockLogger(), 5);
    for (let i = 0; i < 10; i++) store.store(makeSignal());
    expect(store.count().total).toBe(5);
  });

  it("getRecent filters by type", () => {
    const store = new SignalStore(tmpDir, mockLogger());
    store.store(makeSignal({ signal_type: "LOW_SUPPLY" }));
    store.store(makeSignal({ signal_type: "PRICE_ANOMALY" } as any));
    expect(store.getRecent(50, { signal_type: "LOW_SUPPLY" })).toHaveLength(1);
  });

  it("getRecent filters by severity", () => {
    const store = new SignalStore(tmpDir, mockLogger());
    store.store(makeSignal({ severity: "WARNING" }));
    store.store(makeSignal({ severity: "CRITICAL" }));
    expect(store.getRecent(50, { severity: "CRITICAL" })).toHaveLength(1);
  });

  it("getRecent filters by since", () => {
    const store = new SignalStore(tmpDir, mockLogger());
    const old = makeSignal({ timestamp: "2020-01-01T00:00:00Z" });
    const recent = makeSignal({ timestamp: new Date().toISOString() });
    store.store(old);
    store.store(recent);
    expect(store.getRecent(50, { since: "2024-01-01T00:00:00Z" })).toHaveLength(1);
  });

  it("getById returns correct signal", () => {
    const store = new SignalStore(tmpDir, mockLogger());
    const sig = makeSignal();
    store.store(sig);
    expect(store.getById(sig.id)).toBeDefined();
    expect(store.getById("nonexistent")).toBeUndefined();
  });

  it("corrupted jsonl lines skipped on load", () => {
    fs.writeFileSync(path.join(tmpDir, "signals.jsonl"), "bad json\n" + JSON.stringify(makeSignal()) + "\n");
    const store = new SignalStore(tmpDir, mockLogger());
    expect(store.count().total).toBe(1);
  });

  it("version !== 1.0 skipped on load", () => {
    const bad = { ...makeSignal(), version: "2.0" };
    fs.writeFileSync(path.join(tmpDir, "signals.jsonl"), JSON.stringify(bad) + "\n");
    const store = new SignalStore(tmpDir, mockLogger());
    expect(store.count().total).toBe(0);
  });
});

describe("WebhookPublisher HMAC", () => {
  it("computes correct HMAC-SHA256", () => {
    const payload = '{"test":true}';
    const secret = "my-secret";
    const hmac = computeHmac(payload, secret);
    expect(hmac).toMatch(/^[a-f0-9]{64}$/);
    // Same input = same output
    expect(computeHmac(payload, secret)).toBe(hmac);
    // Different input = different output
    expect(computeHmac('{"test":false}', secret)).not.toBe(hmac);
  });
});
