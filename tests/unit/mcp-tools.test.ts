import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { McpToolSurface } from "../../src/mcp/tools.js";
import { SurplusRouter } from "../../src/surplus/surplus-router.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("McpToolSurface", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "mcp-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("registers all expected tools", () => {
    const surface = new McpToolSurface(mockLogger());
    const tools = surface.getTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain("agent_status");
    expect(names).toContain("litcoin_burn_stats");
    expect(names).toContain("relay_health");
    expect(names).toContain("trading_pnl");
    expect(names).toContain("surplus_status");
    expect(names).toContain("run_trading_desk");
  });

  it("executes agent_status without dependencies", async () => {
    const surface = new McpToolSurface(mockLogger());
    const result = await surface.execute("agent_status", {});
    expect(result).toBeDefined();
  });

  it("returns error for unknown tool", async () => {
    const surface = new McpToolSurface(mockLogger());
    await expect(surface.execute("nonexistent", {})).rejects.toThrow("Unknown tool");
  });

  it("trading_pnl returns data when surplus router is wired", async () => {
    const surface = new McpToolSurface(mockLogger());
    const surplus = new SurplusRouter(tmpDir, mockLogger());
    surplus.recordVenuePnl("test", 10, 5, 1, 8);
    surface.wire({ surplus });

    const result = (await surface.execute("trading_pnl", {})) as Record<string, unknown>;
    expect(result.today).toBeDefined();
    expect((result.today as Record<string, number>).realized).toBe(10);
  });

  it("surplus_status returns error when not wired", async () => {
    const surface = new McpToolSurface(mockLogger());
    const result = (await surface.execute("surplus_status", {})) as Record<string, string>;
    expect(result.error).toBeDefined();
  });

  it("surplus_status returns allocation when wired", async () => {
    const surface = new McpToolSurface(mockLogger());
    const surplus = new SurplusRouter(tmpDir, mockLogger());
    surface.wire({ surplus });

    const result = (await surface.execute("surplus_status", {})) as Record<string, unknown>;
    expect(result.routed_to_regen_usd).toBeDefined();
  });
});
