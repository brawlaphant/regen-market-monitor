/**
 * MCP Tool Surface
 *
 * Exposes agent capabilities as tool definitions so Claude (or any MCP client)
 * can operate the agent. Each tool is a JSON-RPC compatible definition with
 * name, description, input schema, and handler.
 *
 * Tools cover:
 * - Agent status and health
 * - Signal querying across all venues
 * - Litcoin position and burn stats
 * - P&L and surplus routing
 * - Strategy execution triggers
 */

import type { Logger } from "../logger.js";
import type { RelayClient } from "../litcoin/relay-client.js";
import type { SurplusRouter } from "../surplus/surplus-router.js";
import type { MultiVenueOrchestrator } from "../strategies/multi-venue-orchestrator.js";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export class McpToolSurface {
  private logger: Logger;
  private relay: RelayClient | null;
  private surplus: SurplusRouter | null;
  private orchestrator: MultiVenueOrchestrator | null;
  private healthFn: (() => Record<string, unknown>) | null;

  constructor(logger: Logger) {
    this.logger = logger;
    this.relay = null;
    this.surplus = null;
    this.orchestrator = null;
    this.healthFn = null;
  }

  /** Wire dependencies after construction */
  wire(deps: {
    relay?: RelayClient;
    surplus?: SurplusRouter;
    orchestrator?: MultiVenueOrchestrator;
    healthFn?: () => Record<string, unknown>;
  }): void {
    if (deps.relay) this.relay = deps.relay;
    if (deps.surplus) this.surplus = deps.surplus;
    if (deps.orchestrator) this.orchestrator = deps.orchestrator;
    if (deps.healthFn) this.healthFn = deps.healthFn;
  }

  /** Return all registered MCP tools */
  getTools(): McpToolDef[] {
    return [
      this.agentStatus(),
      this.litcoinBurnStats(),
      this.relayHealth(),
      this.tradingPnl(),
      this.surplusStatus(),
      this.runTradingDesk(),
    ];
  }

  /** Find and execute a tool by name */
  async execute(name: string, input: Record<string, unknown>): Promise<unknown> {
    const tool = this.getTools().find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(input);
  }

  // ─── Tool Definitions ────────────────────────────────────────────

  private agentStatus(): McpToolDef {
    return {
      name: "agent_status",
      description: "Get the agent's current health, uptime, configured venues, and relay status. Use this to check if the agent is running correctly.",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        const health = this.healthFn ? this.healthFn() : {};
        const relayHealth = this.relay ? await this.relay.checkHealth() : null;
        return {
          ...health,
          litcredit_relay: relayHealth,
          venues_configured: {
            regen: true,
            polymarket: this.relay?.isConfigured || false,
            hyperliquid: !!process.env.HYPERLIQUID_PK,
          },
        };
      },
    };
  }

  private litcoinBurnStats(): McpToolDef {
    return {
      name: "litcoin_burn_stats",
      description: "Get today's LITCREDIT burn statistics — how much the agent has spent on AI inference. Every scoring call burns LITCREDIT on-chain.",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        if (!this.relay) return { error: "Relay not configured" };
        return this.relay.getBurnStats();
      },
    };
  }

  private relayHealth(): McpToolDef {
    return {
      name: "relay_health",
      description: "Check LITCREDIT relay connectivity and provider availability.",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        if (!this.relay) return { error: "Relay not configured" };
        return this.relay.checkHealth();
      },
    };
  }

  private tradingPnl(): McpToolDef {
    return {
      name: "trading_pnl",
      description: "Get today's trading P&L across all venues (REGEN, Polymarket, Hyperliquid). Shows realized/unrealized P&L, trade count, and spend.",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        if (!this.surplus) return { error: "Surplus router not configured" };
        return {
          today: this.surplus.getTodayPnl(),
          state: this.surplus.getState(),
        };
      },
    };
  }

  private surplusStatus(): McpToolDef {
    return {
      name: "surplus_status",
      description: "Check how much trading surplus is available for routing to REGEN accumulation. Shows the economic loop: trade profits → REGEN → ecocredit retirement.",
      inputSchema: { type: "object", properties: {}, required: [] },
      handler: async () => {
        if (!this.surplus) return { error: "Surplus router not configured" };
        return this.surplus.calculateSurplus();
      },
    };
  }

  private runTradingDesk(): McpToolDef {
    return {
      name: "run_trading_desk",
      description: "Trigger a multi-venue trading scan across Polymarket + Hyperliquid. Scans for signals, scores via LITCREDIT, and reports results. Does NOT auto-execute trades unless explicitly configured.",
      inputSchema: {
        type: "object",
        properties: {
          dry_run: { type: "boolean", description: "If true, scan only — no execution (default: true)" },
        },
        required: [],
      },
      handler: async (input) => {
        if (!this.orchestrator) return { error: "Multi-venue orchestrator not configured" };
        const result = await this.orchestrator.run();
        return result;
      },
    };
  }
}
