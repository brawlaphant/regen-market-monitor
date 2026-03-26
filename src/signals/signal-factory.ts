import type {
  MarketSignal,
  SignalType,
  SignalData,
  SignalContext,
  SignalRouting,
  BroadcastChannel,
  PriceAnomalyData,
  ManipulationAlertData,
} from "./signal-schema.js";
import { ROUTING_TABLE, TTL_TABLE } from "./signal-schema.js";
import { MarketSignalSchema } from "../schemas.js";

let pollSequence = 0;

export function nextPollSequence(): number {
  return ++pollSequence;
}

/**
 * Build a validated MarketSignal. Throws if the result fails Zod validation.
 */
export function buildSignal(
  type: SignalType,
  data: SignalData,
  context: Partial<SignalContext>,
  configuredChannels?: BroadcastChannel[]
): MarketSignal {
  const severity = computeSeverity(type, data);

  const routing: SignalRouting = {
    target_agents: ROUTING_TABLE[type],
    broadcast_channels: configuredChannels ?? ["rest"],
    ttl_seconds: TTL_TABLE[type],
    priority: severity === "CRITICAL" ? 1 : severity === "WARNING" ? 2 : 3,
  };

  const fullContext: SignalContext = {
    triggered_by: context.triggered_by ?? "scheduled_poll",
    workflow_id: context.workflow_id ?? "unknown",
    poll_sequence: context.poll_sequence ?? pollSequence,
    related_signal_ids: context.related_signal_ids ?? [],
  };

  const signal: MarketSignal = {
    id: crypto.randomUUID(),
    version: "1.0",
    source: "regen-market-monitor",
    agent_id: "AGENT-003",
    signal_type: type,
    severity,
    timestamp: new Date().toISOString(),
    data,
    context: fullContext,
    routing,
  };

  // Validate before returning
  const result = MarketSignalSchema.safeParse(signal);
  if (!result.success) {
    throw new Error(`Signal validation failed: ${result.error.message}`);
  }

  return signal;
}

function computeSeverity(
  type: SignalType,
  data: SignalData
): "INFO" | "WARNING" | "CRITICAL" {
  if (type === "MANIPULATION_ALERT") return "CRITICAL";

  if (type === "PRICE_ANOMALY") {
    const d = data as PriceAnomalyData;
    if (d.z_score >= 3.5) return "CRITICAL";
    if (d.z_score >= 2.0) return "WARNING";
    return "INFO";
  }

  if (type === "LIQUIDITY_WARNING" || type === "LOW_SUPPLY" || type === "CURATION_DEGRADED" || type === "PRICE_MOVEMENT") {
    return "WARNING";
  }

  return "INFO";
}
