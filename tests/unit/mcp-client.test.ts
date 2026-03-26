import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { McpClient } from "../../src/mcp-client.js";
import { createMockConfig, createMockLogger, wrapMcpResponse } from "../helpers/mocks.js";

describe("McpClient", () => {
  let client: McpClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const config = createMockConfig({ mcpRetryAttempts: 3, mcpTimeoutMs: 10000 });
    client = new McpClient("http://localhost:3100/mcp", config, createMockLogger());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function successResponse(data: unknown): Response {
    const mcpResult = wrapMcpResponse(data);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: mcpResult }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("successful call returns typed result", async () => {
    const payload = { price_usd: 0.042, change_24h: 2.5 };
    mockFetch.mockResolvedValueOnce(successResponse(payload));

    const result = await client.callTool("get_regen_price");
    expect(result.content).toHaveLength(1);

    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.price_usd).toBe(0.042);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("HTTP 500 triggers retry, exhausts retries, throws", async () => {
    vi.useRealTimers(); // Use real timers — retry delays are short enough

    // Create a fresh client with 1 retry attempt (no delays to wait for)
    const config = createMockConfig({ mcpRetryAttempts: 1, mcpTimeoutMs: 10000 });
    const singleRetryClient = new McpClient("http://localhost:3100/mcp", config, createMockLogger());

    mockFetch.mockImplementation(async () =>
      new Response("Internal Server Error", { status: 500 })
    );

    await expect(singleRetryClient.callTool("check_supply_health")).rejects.toThrow(
      "MCP call check_supply_health failed (500)"
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.useFakeTimers(); // Restore for other tests
  });

  it("successful after 2 failures returns result", async () => {
    const payload = { available_credits: 5000 };
    let callNum = 0;
    mockFetch.mockImplementation(async () => {
      callNum++;
      if (callNum <= 2) return new Response("error", { status: 500 });
      return successResponse(payload);
    });

    const callPromise = client.callTool("check_supply_health");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await callPromise;
    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.available_credits).toBe(5000);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  describe("parseAndValidate", () => {
    const TestSchema = z.object({
      name: z.string(),
      value: z.number(),
    });

    it("valid schema returns success", () => {
      const mcpResponse = wrapMcpResponse({ name: "test", value: 42 });
      const result = McpClient.parseAndValidate(mcpResponse, TestSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("test");
        expect(result.data.value).toBe(42);
      }
    });

    it("invalid JSON returns failure", () => {
      const mcpResponse = { content: [{ type: "text", text: "not valid json {{{" }] };
      const result = McpClient.parseAndValidate(mcpResponse, TestSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid JSON");
      }
    });

    it("schema mismatch returns failure with raw", () => {
      const mcpResponse = wrapMcpResponse({ name: 123, value: "wrong" });
      const result = McpClient.parseAndValidate(mcpResponse, TestSchema);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeTruthy();
        expect(result.raw).toContain("123");
      }
    });
  });
});
