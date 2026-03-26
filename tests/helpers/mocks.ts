import type {
  SupplyHealth,
  RegenPrice,
  AvailableCreditsResult,
  AvailableCredit,
  CommunityGoalsResult,
  CommunityGoal,
  PersistedAlertState,
  PriceSnapshot,
  AnomalyReport,
  LiquidityReport,
  RetirementReport,
  McpToolResponse,
  Config,
} from "../../src/types.js";

// ─── Config ─────────────────────────────────────────────────────────

export function createMockConfig(overrides: Partial<Config> = {}): Config {
  return {
    regenComputeMcpUrl: "http://localhost:3100/mcp",
    telegramBotToken: undefined,
    telegramChatId: undefined,
    pollIntervalMs: 3600000,
    lowStockThreshold: 1000,
    priceMoveThreshold: 0.10,
    alertCooldownMs: 3600000,
    logLevel: "error",
    port: 3099,
    dailyDigestHourUtc: 9,
    dataDir: "./data",
    mcpTimeoutMs: 10000,
    mcpRetryAttempts: 3,
    ...overrides,
  };
}

// ─── MCP Responses ──────────────────────────────────────────────────

export function mockSupplyHealth(overrides: Partial<SupplyHealth> = {}): SupplyHealth {
  return {
    available_credits: 5000,
    total_supply: 50000,
    retired_credits: 12000,
    health_score: 72,
    credit_classes: [
      { class_id: "C01", class_name: "Carbon", available: 3000, retired: 8000, health: "good" },
      { class_id: "C02", class_name: "Biodiversity", available: 2000, retired: 4000, health: "good" },
    ],
    ...overrides,
  };
}

export function mockRegenPrice(overrides: Partial<RegenPrice> = {}): RegenPrice {
  return {
    price_usd: 0.042,
    change_24h: 2.5,
    volume_24h: 125000,
    market_cap: 12500000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

export function mockAvailableCredits(overrides: Partial<AvailableCreditsResult> = {}): AvailableCreditsResult {
  const credits: AvailableCredit[] = [
    { batch_denom: "C01-001-20200101-20201231-001", class_id: "C01", project_id: "P001", tradable_amount: 1000, retired_amount: 500, ask_price_usd: 5.50, vintage_start: "2020-01-01" },
    { batch_denom: "C01-002-20210101-20211231-001", class_id: "C01", project_id: "P002", tradable_amount: 2000, retired_amount: 800, ask_price_usd: 6.00, vintage_start: "2021-01-01" },
    { batch_denom: "C02-001-20220101-20221231-001", class_id: "C02", project_id: "P003", tradable_amount: 500, retired_amount: 200, ask_price_usd: 12.00, vintage_start: "2022-01-01" },
    { batch_denom: "C02-002-20230101-20231231-001", class_id: "C02", project_id: "P004", tradable_amount: 1500, retired_amount: 300, ask_price_usd: 11.50, vintage_start: "2023-01-01" },
    { batch_denom: "C01-003-20240101-20241231-001", class_id: "C01", project_id: "P005", tradable_amount: 800, retired_amount: 100, ask_price_usd: 7.25, vintage_start: "2024-01-01" },
  ];
  return {
    credits: overrides.credits ?? credits,
    total_listed_value_usd: overrides.total_listed_value_usd ?? 42350,
    total_tradable: overrides.total_tradable ?? 5800,
  };
}

export function mockCommunityGoals(overrides: Partial<CommunityGoalsResult> = {}): CommunityGoalsResult {
  const goals: CommunityGoal[] = [
    { id: "goal-mangrove-2026", name: "Mangrove Restoration 2026", target: 50000, current: 35000, percent_complete: 70 },
    { id: "goal-forest-2026", name: "Forest Conservation 2026", target: 100000, current: 45000, percent_complete: 45 },
    { id: "goal-soil-2026", name: "Soil Carbon 2026", target: 25000, current: 22500, percent_complete: 90 },
  ];
  return { goals: overrides.goals ?? goals };
}

// ─── Wrap data as MCP tool response ─────────────────────────────────

export function wrapMcpResponse(data: unknown): McpToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

export function mockMCPResponse(tool: string, overrides?: Record<string, unknown>): McpToolResponse {
  switch (tool) {
    case "check_supply_health":
      return wrapMcpResponse(mockSupplyHealth(overrides as Partial<SupplyHealth>));
    case "get_regen_price":
      return wrapMcpResponse(mockRegenPrice(overrides as Partial<RegenPrice>));
    case "browse_available_credits":
      return wrapMcpResponse(mockAvailableCredits(overrides as Partial<AvailableCreditsResult>));
    case "get_community_goals":
      return wrapMcpResponse(mockCommunityGoals(overrides as Partial<CommunityGoalsResult>));
    default:
      throw new Error(`Unknown MCP tool: ${tool}`);
  }
}

// ─── Alert State ────────────────────────────────────────────────────

export function createMockAlertState(overrides: Partial<PersistedAlertState> = {}): PersistedAlertState {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  return {
    lastFired: { "Low Credit Stock": Date.now() - 7200000 },
    alertsFiredToday: 2,
    dayStart,
    ...overrides,
  };
}

// ─── Price History ──────────────────────────────────────────────────

export function createMockPriceHistory(
  points = 24,
  trend: "up" | "down" | "flat" | "spike" = "flat"
): PriceSnapshot[] {
  const base = 0.042;
  const history: PriceSnapshot[] = [];
  const now = Date.now();

  for (let i = 0; i < points; i++) {
    let price: number;
    switch (trend) {
      case "up":
        price = base + (i * 0.001);
        break;
      case "down":
        price = base - (i * 0.0005);
        break;
      case "spike":
        price = i === points - 1 ? base * 3 : base + (Math.random() * 0.002 - 0.001);
        break;
      default:
        price = base + (Math.random() * 0.002 - 0.001);
    }
    history.push({
      price_usd: Math.max(0.001, price),
      timestamp: new Date(now - (points - i) * 3600000).toISOString(),
    });
  }
  return history;
}

// ─── Anomaly Reports ────────────────────────────────────────────────

export function createMockAnomalyReport(
  severity: "normal" | "warning" | "critical" = "normal",
  overrides: Partial<AnomalyReport> = {}
): AnomalyReport {
  const base: Record<string, Partial<AnomalyReport>> = {
    normal: { z_score: 0.5, status: "normal", current_price: 0.042, median_price: 0.041 },
    warning: { z_score: 2.5, status: "watchlist", current_price: 0.055, median_price: 0.042 },
    critical: { z_score: 4.0, status: "flagged", current_price: 0.089, median_price: 0.042 },
  };
  return {
    current_price: 0.042,
    median_price: 0.041,
    z_score: 0.5,
    status: "normal",
    price_change_pct: 0.02,
    timestamp: new Date(),
    ...base[severity],
    ...overrides,
  };
}

export function createMockLiquidityReport(overrides: Partial<LiquidityReport> = {}): LiquidityReport {
  return {
    listed_value_usd: 42350,
    total_tradable: 5800,
    health_score: 72,
    available_credits: 5000,
    credit_class_count: 2,
    timestamp: new Date(),
    ...overrides,
  };
}

export function createMockRetirementReport(overrides: Partial<RetirementReport> = {}): RetirementReport {
  return {
    goals: mockCommunityGoals().goals,
    completed_goals: [],
    total_retired: 12000,
    demand_signal: "moderate",
    timestamp: new Date(),
    ...overrides,
  };
}

// ─── Logger mock ────────────────────────────────────────────────────

export function createMockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => createMockLogger(),
    level: "error",
  } as any;
}
