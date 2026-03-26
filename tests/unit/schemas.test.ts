import { describe, it, expect } from "vitest";
import {
  SupplyHealthSchema,
  RegenPriceSchema,
  AvailableCreditsResultSchema,
  CommunityGoalsResultSchema,
  AvailableCreditSchema,
  CommunityGoalSchema,
  CreditClassHealthSchema,
} from "../../src/schemas.js";
import { McpClient } from "../../src/mcp-client.js";
import {
  mockSupplyHealth,
  mockRegenPrice,
  mockAvailableCredits,
  mockCommunityGoals,
  wrapMcpResponse,
} from "../helpers/mocks.js";

// ─── CreditClassHealthSchema ──────────────────────────────────────

describe("CreditClassHealthSchema", () => {
  it("valid data passes", () => {
    const data = { class_id: "C01", class_name: "Carbon", available: 3000, retired: 8000, health: "good" };
    const result = CreditClassHealthSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("missing required field fails", () => {
    const data = { class_id: "C01", class_name: "Carbon", available: 3000, retired: 8000 };
    const result = CreditClassHealthSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("wrong type fails", () => {
    const data = { class_id: "C01", class_name: "Carbon", available: "not-a-number", retired: 8000, health: "good" };
    const result = CreditClassHealthSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("extra fields are stripped by parse", () => {
    const data = { class_id: "C01", class_name: "Carbon", available: 3000, retired: 8000, health: "good", extra: "field" };
    const parsed = CreditClassHealthSchema.parse(data);
    expect(parsed).not.toHaveProperty("extra");
  });
});

// ─── SupplyHealthSchema ───────────────────────────────────────────

describe("SupplyHealthSchema", () => {
  it("valid data passes", () => {
    const result = SupplyHealthSchema.safeParse(mockSupplyHealth());
    expect(result.success).toBe(true);
  });

  it("missing required field fails", () => {
    const { health_score, ...rest } = mockSupplyHealth();
    const result = SupplyHealthSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("wrong type fails", () => {
    const data = { ...mockSupplyHealth(), available_credits: "not-a-number" };
    const result = SupplyHealthSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("extra fields are stripped by parse", () => {
    const data = { ...mockSupplyHealth(), bonus: 42 };
    const parsed = SupplyHealthSchema.parse(data);
    expect(parsed).not.toHaveProperty("bonus");
  });
});

// ─── RegenPriceSchema ─────────────────────────────────────────────

describe("RegenPriceSchema", () => {
  it("valid data passes", () => {
    const result = RegenPriceSchema.safeParse(mockRegenPrice());
    expect(result.success).toBe(true);
  });

  it("missing required field fails", () => {
    const { price_usd, ...rest } = mockRegenPrice();
    const result = RegenPriceSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("wrong type fails", () => {
    const data = { ...mockRegenPrice(), volume_24h: "big" };
    const result = RegenPriceSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("extra fields are stripped by parse", () => {
    const data = { ...mockRegenPrice(), source: "coingecko" };
    const parsed = RegenPriceSchema.parse(data);
    expect(parsed).not.toHaveProperty("source");
  });
});

// ─── AvailableCreditSchema ────────────────────────────────────────

describe("AvailableCreditSchema", () => {
  it("valid data passes", () => {
    const data = {
      batch_denom: "C01-001-20200101-20201231-001",
      class_id: "C01",
      project_id: "P001",
      tradable_amount: 1000,
      retired_amount: 500,
      ask_price_usd: 5.50,
      vintage_start: "2020-01-01",
    };
    const result = AvailableCreditSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("missing required field fails", () => {
    const data = {
      class_id: "C01",
      project_id: "P001",
      tradable_amount: 1000,
      retired_amount: 500,
    };
    // missing batch_denom
    const result = AvailableCreditSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("wrong type fails", () => {
    const data = {
      batch_denom: "C01-001-20200101-20201231-001",
      class_id: "C01",
      project_id: "P001",
      tradable_amount: "one thousand",
      retired_amount: 500,
    };
    const result = AvailableCreditSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("extra fields are stripped by parse", () => {
    const data = {
      batch_denom: "C01-001-20200101-20201231-001",
      class_id: "C01",
      project_id: "P001",
      tradable_amount: 1000,
      retired_amount: 500,
      secret: "leaked",
    };
    const parsed = AvailableCreditSchema.parse(data);
    expect(parsed).not.toHaveProperty("secret");
  });
});

// ─── AvailableCreditsResultSchema ─────────────────────────────────

describe("AvailableCreditsResultSchema", () => {
  it("valid data passes", () => {
    const result = AvailableCreditsResultSchema.safeParse(mockAvailableCredits());
    expect(result.success).toBe(true);
  });

  it("missing required field fails", () => {
    const { total_tradable, ...rest } = mockAvailableCredits();
    const result = AvailableCreditsResultSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("wrong type fails", () => {
    const data = { ...mockAvailableCredits(), total_listed_value_usd: "lots" };
    const result = AvailableCreditsResultSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("extra fields are stripped by parse", () => {
    const data = { ...mockAvailableCredits(), page: 2 };
    const parsed = AvailableCreditsResultSchema.parse(data);
    expect(parsed).not.toHaveProperty("page");
  });
});

// ─── CommunityGoalSchema ──────────────────────────────────────────

describe("CommunityGoalSchema", () => {
  it("valid data passes", () => {
    const data = { id: "goal-1", name: "Mangrove", target: 50000, current: 35000, percent_complete: 70 };
    const result = CommunityGoalSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("missing required field fails", () => {
    const data = { id: "goal-1", name: "Mangrove", target: 50000, current: 35000 };
    // missing percent_complete
    const result = CommunityGoalSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("wrong type fails", () => {
    const data = { id: "goal-1", name: "Mangrove", target: "fifty", current: 35000, percent_complete: 70 };
    const result = CommunityGoalSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("extra fields are stripped by parse", () => {
    const data = { id: "goal-1", name: "Mangrove", target: 50000, current: 35000, percent_complete: 70, sponsor: "Acme" };
    const parsed = CommunityGoalSchema.parse(data);
    expect(parsed).not.toHaveProperty("sponsor");
  });
});

// ─── CommunityGoalsResultSchema ───────────────────────────────────

describe("CommunityGoalsResultSchema", () => {
  it("valid data passes", () => {
    const result = CommunityGoalsResultSchema.safeParse(mockCommunityGoals());
    expect(result.success).toBe(true);
  });

  it("missing required field fails", () => {
    const result = CommunityGoalsResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("wrong type fails", () => {
    const data = { goals: "not-an-array" };
    const result = CommunityGoalsResultSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("extra fields are stripped by parse", () => {
    const data = { ...mockCommunityGoals(), meta: "info" };
    const parsed = CommunityGoalsResultSchema.parse(data);
    expect(parsed).not.toHaveProperty("meta");
  });
});

// ─── MCP Response Wrapper + parseAndValidate ──────────────────────

describe("MCP response wrapper integration", () => {
  it("wrapMcpResponse + parseAndValidate with SupplyHealthSchema", () => {
    const supply = mockSupplyHealth();
    const mcpResponse = wrapMcpResponse(supply);
    const result = McpClient.parseAndValidate(mcpResponse, SupplyHealthSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.available_credits).toBe(supply.available_credits);
      expect(result.data.health_score).toBe(supply.health_score);
    }
  });

  it("wrapMcpResponse + parseAndValidate with RegenPriceSchema", () => {
    const price = mockRegenPrice();
    const mcpResponse = wrapMcpResponse(price);
    const result = McpClient.parseAndValidate(mcpResponse, RegenPriceSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.price_usd).toBe(price.price_usd);
    }
  });

  it("wrapMcpResponse + parseAndValidate with AvailableCreditsResultSchema", () => {
    const credits = mockAvailableCredits();
    const mcpResponse = wrapMcpResponse(credits);
    const result = McpClient.parseAndValidate(mcpResponse, AvailableCreditsResultSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.credits.length).toBe(credits.credits.length);
    }
  });

  it("wrapMcpResponse + parseAndValidate with CommunityGoalsResultSchema", () => {
    const goals = mockCommunityGoals();
    const mcpResponse = wrapMcpResponse(goals);
    const result = McpClient.parseAndValidate(mcpResponse, CommunityGoalsResultSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.goals.length).toBe(goals.goals.length);
    }
  });
});
