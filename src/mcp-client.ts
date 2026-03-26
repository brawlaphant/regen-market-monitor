import type { McpToolResponse } from "./types.js";
import type { Logger } from "./logger.js";

/**
 * Lightweight MCP client that calls regen-compute tools over HTTP.
 * Sends JSON-RPC 2.0 requests to the MCP server endpoint.
 */
export class McpClient {
  private url: string;
  private logger: Logger;
  private requestId = 0;

  constructor(url: string, logger: Logger) {
    this.url = url;
    this.logger = logger;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {}
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

    this.logger.debug({ tool: name, result: json.result }, "MCP tool response");
    return json.result!;
  }

  /** Parse the text content from an MCP tool response */
  static parseText(response: McpToolResponse): string {
    const textBlock = response.content.find((c) => c.type === "text");
    return textBlock?.text ?? "";
  }

  /** Parse JSON from an MCP tool response text block */
  static parseJson<T>(response: McpToolResponse): T {
    const text = McpClient.parseText(response);
    return JSON.parse(text) as T;
  }
}
