# regen-market-monitor

Autonomous ElizaOS agent that monitors Regen Network ecocredit market conditions. Implements **AGENT-003 (RegenMarketMonitor)** from the [Regen Network Agentic Tokenomics](https://github.com/regen-network/agentic-tokenomics) specification — four OODA-loop workflows that detect price anomalies, assess liquidity, analyze retirement patterns, and score curation quality, with configurable alerts delivered via Telegram.

## Quick Start

```bash
git clone https://github.com/brawlaphant/regen-market-monitor.git
cd regen-market-monitor
npm install
cp .env.example .env
# Edit .env — set REGEN_COMPUTE_MCP_URL at minimum
npm run build && npm start
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
| `PORT` | No | `3099` | HTTP port for health and state endpoints |
| `DAILY_DIGEST_HOUR_UTC` | No | `9` | UTC hour (0-23) to send daily Telegram digest |
| `DATA_DIR` | No | `./data` | Directory for persistent JSON state files |
| `MCP_TIMEOUT_MS` | No | `10000` | Timeout per MCP tool call (ms) |
| `MCP_RETRY_ATTEMPTS` | No | `3` | Retry attempts for failed MCP calls |
| `LOG_LEVEL` | No | `info` | Logging level (trace/debug/info/warn/error/fatal) |

If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` are not set, alerts fall back to structured JSON logs — the agent still runs.

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
| INFO | Community goal completed, high retirement demand | Log and notify |
| WARNING | Low credit stock, price move >10%, z-score 2.0-3.5, health declining, quality degradation, MCP tool unreachable | Notify and add to watchlist |
| CRITICAL | Z-score >=3.5 (manipulation flag), market health <30 | Immediate escalation (sent twice, 60s apart) |

All alerts are deduplicated — the same alert won't fire again within `ALERT_COOLDOWN_MS`. Cooldowns persist across restarts.

## Health Endpoint

The agent exposes a lightweight HTTP server (default port 3099) for monitoring:

```bash
# Agent status — is the agent alive, when did it last poll, is MCP reachable?
curl http://localhost:3099/health
```

```json
{
  "status": "ok",
  "lastPollAt": "2026-03-26T14:30:00.000Z",
  "nextPollAt": "2026-03-26T15:30:00.000Z",
  "mcpReachable": true,
  "alertsFiredToday": 2,
  "uptime": 86400
}
```

```bash
# Full market snapshot — last known values from every MCP tool
curl http://localhost:3099/state
```

Returns the complete market state including price, supply health, available credits, community goals, and all computed reports (anomaly, liquidity, retirement, curation).

## Data Persistence

The agent persists state to the `data/` directory (configurable via `DATA_DIR`):

| File | Contents | Purpose |
|---|---|---|
| `data/price-history.json` | Rolling window of last 24 price snapshots | Z-score computation survives restarts; min 5 points required |
| `data/alert-state.json` | Alert cooldown timestamps + daily counter | Deduplication survives restarts |
| `data/market-snapshot.json` | Last complete market state | Serve stale data from `/state` before first poll completes |

All writes are atomic (write to `.tmp` then rename). On shutdown, the agent completes any in-progress workflow cycle and flushes all data files before exiting.

## Daily Digest

At the configured UTC hour (default 09:00), a Telegram summary is sent regardless of alert state:

- Current REGEN price + 24h change
- Total credits available across monitored batches
- Community goal progress with visual bars
- Number of alerts fired in last 24h
- Agent uptime

## PM2 Deployment

An `ecosystem.config.cjs` is included for PM2:

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 logs regen-market-monitor
pm2 save
```

## Example Telegram Output

**Low Credit Stock:**
```
WARNING Low Credit Stock

Available credits (847) fell below threshold (1,000). Listed value: $42,350.

  available: 847
  listed_value: 42,350.0000

View on Regen Network: https://app.regen.network/ecocredits/credits
Next check in 60 minutes

2026-03-26 14:30:00 UTC - RegenMarketMonitor
```

**Price Manipulation (CRITICAL — sent twice, 60s apart):**
```
CRITICAL Price Manipulation Flagged

Z-score 4.12 exceeds manipulation threshold (3.5). Current price $0.0891, median $0.0412.
Change: +116.3% from last poll
Trend: up up down

  z_score: 4.1200
  price: 0.0891
  median: 0.0412

View on Regen Network: https://app.regen.network/ecocredits/portfolio
Next check in 60 minutes

2026-03-26 14:30:00 UTC - RegenMarketMonitor
```

**Community Goal Completed:**
```
INFO Community Goal Completed

"Mangrove Restoration 2026" reached 100% completion (50,000/50,000 credits).

  goal_id: goal-mangrove-2026
  goal_name: Mangrove Restoration 2026
  target: 50,000

View on Regen Network: https://app.regen.network/ecocredits/credits
Next check in 60 minutes

2026-03-26 08:00:00 UTC - RegenMarketMonitor
```

## Architecture

```
src/
├── index.ts                          # Entry point — wires everything together
├── config.ts                         # Environment variable parsing
├── types.ts                          # Shared type definitions
├── schemas.ts                        # Zod schemas for MCP response validation
├── logger.ts                         # Pino structured JSON logger
├── mcp-client.ts                     # JSON-RPC 2.0 client with retry + timeout
├── data-store.ts                     # Persistent JSON file storage (atomic writes)
├── alerts.ts                         # Alert manager with thresholds + persistent dedup
├── health-server.ts                  # HTTP /health and /state endpoints
├── scheduler.ts                      # Polling loop with graceful shutdown + digest
├── characters/
│   └── market-monitor.character.ts   # AGENT-003 ElizaOS character definition
├── plugins/
│   └── regen-market-plugin.ts        # Four OODA workflows with schema validation
└── notifiers/
    └── telegram.ts                   # Telegram delivery with escalation + digest
```

## Spec Reference

- Agent: [AGENT-003 RegenMarketMonitor](https://github.com/regen-network/agentic-tokenomics/blob/main/phase-2/2.4-agent-orchestration.md)
- Workflows: [WF-MM-01 through WF-MM-04](https://github.com/regen-network/agentic-tokenomics/blob/main/phase-2/2.2-agentic-workflows.md)

## License

Apache-2.0
