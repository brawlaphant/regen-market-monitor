# regen-market-monitor

Autonomous ElizaOS agent that monitors Regen Network ecocredit market conditions. Implements **AGENT-003 (RegenMarketMonitor)** from the [Regen Network Agentic Tokenomics](https://github.com/regen-network/agentic-tokenomics) specification — four OODA-loop workflows that detect price anomalies, assess liquidity, analyze retirement patterns, and score curation quality, with configurable alerts delivered via Telegram.

## Quick Start

```bash
git clone https://github.com/brawlaphant/regen-market-monitor.git
cd regen-market-monitor
npm install
cp .env.example .env
# Edit .env — set REGEN_COMPUTE_MCP_URL at minimum
npm start
```

For development with hot reload:

```bash
npm run dev
```

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Default | Description |
|---|---|---|---|
| `REGEN_COMPUTE_MCP_URL` | Yes | — | URL of the regen-compute MCP server |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | No | — | Telegram chat/channel ID for alerts |
| `POLL_INTERVAL_MS` | No | `3600000` | Polling interval in ms (default 1 hour) |
| `LOW_STOCK_THRESHOLD` | No | `1000` | Alert when available credits drop below this |
| `PRICE_MOVE_THRESHOLD` | No | `0.10` | Alert when price moves more than this fraction (10%) |
| `ALERT_COOLDOWN_MS` | No | `3600000` | Suppress duplicate alerts within this window |
| `LOG_LEVEL` | No | `info` | Logging level (trace/debug/info/warn/error/fatal) |

If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` are not set, alerts fall back to console output — the agent still runs.

## Workflows

Each workflow follows the OODA (Observe-Orient-Decide-Act) loop pattern defined in the agentic tokenomics spec.

| Workflow | ID | Monitors | Frequency | MCP Tools Called |
|---|---|---|---|---|
| Price Anomaly Detection | WF-MM-01 | Price manipulation, z-score deviations | Every poll | `get_regen_price`, `browse_available_credits` |
| Liquidity Monitoring | WF-MM-02 | Order book depth, market health | Every poll | `check_supply_health`, `browse_available_credits` |
| Retirement Pattern Analysis | WF-MM-03 | Retirement demand signals, goal completion | Once per day | `get_community_goals`, `check_supply_health` |
| Curation Quality Scoring | WF-MM-04 | Listing quality, vintage freshness | Every poll | `browse_available_credits`, `check_supply_health` |

## Alert Severity Levels

| Severity | Conditions | Action |
|---|---|---|
| ℹ️ **INFO** | Community goal completed, high retirement demand | Log and notify |
| ⚠️ **WARNING** | Low credit stock, price move >10%, z-score 2.0–3.5, health declining, quality degradation | Notify and add to watchlist |
| 🚨 **CRITICAL** | Z-score ≥3.5 (manipulation flag), market health <30 | Immediate escalation |

All alerts are deduplicated — the same alert won't fire again within `ALERT_COOLDOWN_MS`.

## Example Telegram Output

**Low Credit Stock:**
```
⚠️ [WARNING] Low Credit Stock

Available credits (847) fell below threshold (1,000). Listed value: $42,350.

  available: 847
  threshold: 1,000
  listed_value: 42,350.0000

2026-03-26 14:30:00 UTC — RegenMarketMonitor
```

**Significant Price Movement:**
```
⚠️ [WARNING] Significant Price Movement

REGEN price moved down 12.3% ($0.0412 → $0.0361).

  change_pct: 0.1233
  from: 0.0412
  to: 0.0361

2026-03-26 14:30:00 UTC — RegenMarketMonitor
```

**Community Goal Completed:**
```
ℹ️ [INFO] Community Goal Completed

"Mangrove Restoration 2026" reached 100% completion (50,000/50,000 credits).

  goal_id: goal-mangrove-2026
  goal_name: Mangrove Restoration 2026
  target: 50,000

2026-03-26 08:00:00 UTC — RegenMarketMonitor
```

**Price Manipulation Flagged:**
```
🚨 [CRITICAL] Price Manipulation Flagged

Z-score 4.12 exceeds manipulation threshold (3.5). Current price $0.0891, median $0.0412.

  z_score: 4.1200
  price: 0.0891
  median: 0.0412

2026-03-26 14:30:00 UTC — RegenMarketMonitor
```

## Architecture

```
src/
├── index.ts                          # Entry point — wires everything together
├── config.ts                         # Environment variable parsing
├── types.ts                          # Shared type definitions
├── logger.ts                         # Pino logger factory
├── mcp-client.ts                     # JSON-RPC 2.0 client for MCP tool calls
├── alerts.ts                         # Alert manager with thresholds + dedup
├── scheduler.ts                      # Polling loop with configurable intervals
├── characters/
│   └── market-monitor.character.ts   # AGENT-003 ElizaOS character definition
├── plugins/
│   └── regen-market-plugin.ts        # Four OODA workflows (WF-MM-01..04)
└── notifiers/
    └── telegram.ts                   # Telegram alert delivery
```

## Spec Reference

- Agent: [AGENT-003 RegenMarketMonitor](https://github.com/regen-network/agentic-tokenomics/blob/main/phase-2/2.4-agent-orchestration.md)
- Workflows: [WF-MM-01 through WF-MM-04](https://github.com/regen-network/agentic-tokenomics/blob/main/phase-2/2.2-agentic-workflows.md)

## License

Apache-2.0
