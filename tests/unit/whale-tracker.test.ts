import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { WalletRegistry } from "../../src/chain/whale/wallet-registry.js";
import { MovementDetector } from "../../src/chain/whale/movement-detector.js";
import { PatternAnalyzer } from "../../src/chain/whale/pattern-analyzer.js";
import type { WalletMovement } from "../../src/chain/whale/movement-detector.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("WalletRegistry", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(tmpdir(), "whale-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("adds wallets and retrieves by balance", () => {
    const registry = new WalletRegistry(mockLogger(), tmpDir);
    registry.addWallet("addr1", "Whale 1", "regen");
    registry.addWallet("addr2", "Whale 2", "regen");
    const wallets = registry.getTopByBalance(10);
    expect(wallets.length).toBeGreaterThanOrEqual(2);
  });

  it("pre-labels known addresses", () => {
    const registry = new WalletRegistry(mockLogger(), tmpDir);
    const all = registry.getTopByBalance(100);
    // Should have pre-labeled wallets from constructor
    expect(all.length).toBeGreaterThan(0);
  });
});

describe("MovementDetector", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(tmpdir(), "mvmt-")); });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.WHALE_CRITICAL_THRESHOLD_REGEN;
    delete process.env.WHALE_HIGH_THRESHOLD_REGEN;
    delete process.env.WHALE_MEDIUM_THRESHOLD_REGEN;
  });

  it("classifies significance by threshold", () => {
    process.env.WHALE_CRITICAL_THRESHOLD_REGEN = "500000";
    process.env.WHALE_HIGH_THRESHOLD_REGEN = "100000";
    process.env.WHALE_MEDIUM_THRESHOLD_REGEN = "10000";
    const detector = new MovementDetector(mockLogger(), tmpDir);

    expect(detector.classifySignificance(600000)).toBe("critical");
    expect(detector.classifySignificance(200000)).toBe("high");
    expect(detector.classifySignificance(50000)).toBe("medium");
    expect(detector.classifySignificance(5000)).toBe("low");
  });
});

describe("PatternAnalyzer", () => {
  function makeMovement(overrides: Partial<WalletMovement> = {}): WalletMovement {
    return {
      id: crypto.randomUUID(),
      wallet_address: "addr1",
      wallet_label: "Whale",
      wallet_tier: "large",
      chain: "regen",
      movement_type: "receive",
      amount_regen: 100000,
      amount_usd: 4000,
      tx_hash: "hash",
      block_height: 1000,
      timestamp: new Date().toISOString(),
      significance: "high",
      ...overrides,
    };
  }

  it("detects ACCUMULATION_CLUSTER with 3+ receiving wallets", () => {
    const analyzer = new PatternAnalyzer();
    const movements = [
      makeMovement({ wallet_address: "a1", movement_type: "receive" }),
      makeMovement({ wallet_address: "a2", movement_type: "receive" }),
      makeMovement({ wallet_address: "a3", movement_type: "receive" }),
    ];
    const report = analyzer.analyze(movements, 24);
    expect(report.patterns_detected.map(p => p.type)).toContain("ACCUMULATION_CLUSTER");
    expect(report.dominant_signal).toBe("bullish");
  });

  it("detects DISTRIBUTION_CLUSTER with 3+ sending wallets", () => {
    const analyzer = new PatternAnalyzer();
    const movements = [
      makeMovement({ wallet_address: "a1", movement_type: "send" }),
      makeMovement({ wallet_address: "a2", movement_type: "send" }),
      makeMovement({ wallet_address: "a3", movement_type: "send" }),
    ];
    const report = analyzer.analyze(movements, 24);
    expect(report.patterns_detected.map(p => p.type)).toContain("DISTRIBUTION_CLUSTER");
    expect(report.dominant_signal).toBe("bearish");
  });

  it("detects LP_EXIT pattern", () => {
    const analyzer = new PatternAnalyzer();
    const movements = [
      makeMovement({ wallet_address: "lp1", movement_type: "lp_remove", amount_regen: 500000 }),
    ];
    const report = analyzer.analyze(movements, 24);
    expect(report.patterns_detected.map(p => p.type)).toContain("LP_EXIT");
  });

  it("detects LP_ENTRY pattern", () => {
    const analyzer = new PatternAnalyzer();
    const movements = [
      makeMovement({ wallet_address: "lp1", movement_type: "lp_add", amount_regen: 500000 }),
    ];
    const report = analyzer.analyze(movements, 24);
    expect(report.patterns_detected.map(p => p.type)).toContain("LP_ENTRY");
  });
});
