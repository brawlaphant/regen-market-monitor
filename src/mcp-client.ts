import { z } from "zod";
import type { McpToolResponse, Config } from "./types.js";
import type { Logger } from "./logger.js";

const RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * MCP client with exponential-backoff retry, per-request timeout,
 * and Zod schema validation on responses.
 */
export class McpClient {
  private url: string;
  private logger: Logger;
  private config: Config;
  private requestId = 0;
  /** Track whether the last call succeeded — used by health endpoint */
  public lastCallSucceeded = true;

  constructor(url: string, config: Config, logger: Logger) {
    this.url = url;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Call an MCP tool with retry logic.
   * Retries up to config.mcpRetryAttempts with exponential backoff.
   * Each attempt uses AbortSignal.timeout(config.mcpTimeoutMs).
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<McpToolResponse> {
    const maxAttempts = this.config.mcpRetryAttempts;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.doCall(name, args);
        this.lastCallSucceeded = true;
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          {
            tool: name,
            attempt,
            maxAttempts,
            error: lastError.message,
            timestamp: new Date().toISOString(),
          },
          `MCP call failed (attempt ${attempt}/${maxAttempts})`
        );

        if (attempt < maxAttempts) {
          const delay = RETRY_DELAYS_MS[attempt - 1] ?? 4000;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    this.lastCallSucceeded = false;
    throw lastError!;
  }

  private async doCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolResponse> {
    const id = ++this.requestId;
    const body = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    };

    this.logger.debug({ tool: name, args }, "MCP tool call");

    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.mcpTimeoutMs),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MCP call ${name} failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as {
      result?: McpToolResponse;
      error?: { message: string };
    };

    if (json.error) {
      throw new Error(`MCP tool ${name} error: ${json.error.message}`);
    }

    this.logger.debug({ tool: name }, "MCP tool response OK");
    return json.result!;
  }

  /** Parse text content from an MCP tool response */
  static parseText(response: McpToolResponse): string {
    const textBlock = response.content.find((c) => c.type === "text");
    return textBlock?.text ?? "";
  }

  /**
   * Parse and validate JSON from an MCP tool response using a Zod schema.
   * Returns { success: true, data } or { success: false, error, raw }.
   */
  static parseAndValidate<T>(
    response: McpToolResponse,
    schema: z.ZodType<T>
  ): { success: true; data: T } | { success: false; error: string; raw: string } {
    const text = McpClient.parseText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { success: false, error: "Invalid JSON in MCP response", raw: text };
    }

    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true, data: result.data };
    }

    return {
      success: false,
      error: result.error.message,
      raw: text.slice(0, 500),
    };
  }
}
