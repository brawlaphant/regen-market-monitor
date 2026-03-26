# regen-market-monitor

Autonomous ElizaOS agent that monitors Regen Network ecocredit market conditions. Implements **AGENT-003 (RegenMarketMonitor)** from the [Regen Network Agentic Tokenomics](https://github.com/regen-network/agentic-tokenomics) specification — four OODA-loop workflows that detect price anomalies, assess liquidity, analyze retirement patterns, and score curation quality, with configurable alerts delivered via Telegram.

Includes an **on-chain action layer** that can build and submit governance proposals to freeze suspicious sell orders — always gated by explicit human approval.

## Quick Start

```bash
git clone https://github.com/brawlaphant/regen-market-monitor.git
cd regen-market-monitor
npm install
cp .env.example .env
# Edit .env — set REGEN_COMPUTE_MCP_URL at minimum
npm run build && npm start
```

## Configuration

See `.env.example` for all variables with inline comments. Key groups:

| Variable | Required | Default | Description |
|---|---|---|---|
| `REGEN_COMPUTE_MCP_URL` | Yes | — | MCP server URL |
| `TELEGRAM_BOT_TOKEN` | No | — | Bot token for alerts |
| `TELEGRAM_CHAT_ID` | No | — | Chat ID for alerts |
| `TELEGRAM_ADMIN_CHAT_ID` | No | — | Chat ID authorized to /approve proposals |
| `REGEN_LCD_URL` | No | `https://regen.api.boz.moe` | Regen LCD REST API |
| `REGEN_RPC_URL` | No | `https://regen-rpc.polkachu.com` | Regen Tendermint RPC |
| `REGEN_MNEMONIC` | No | — | BIP39 mnemonic for proposal submission |
| `REGEN_CHAIN_ID` | No | `regen-1` | Chain ID |
| `REGEN_GAS_PRICE` | No | `0.015uregen` | Gas price |
| `GAS_MULTIPLIER` | No | `1.3` | Gas simulation multiplier |
| `EVENT_POLL_INTERVAL_MS` | No | `60000` | Chain event poll interval (1 min) |
| `LARGE_TRADE_THRESHOLD_USD` | No | `10000` | Large trade threshold |
| `PROPOSAL_EXPIRY_MS` | No | `3600000` | Proposal expiry (1 hour) |
| `PORT` | No | `3099` | Health endpoint port |
| `DATA_DIR` | No | `./data` | Persistent data directory |

## On-Chain Action Layer

The AGENT-003 spec grants this agent `authority_level: Layer 1-2` with `can_propose: true` and `can_execute: false`. The agent can draft governance proposals — but **never executes transactions autonomously**.

### Proposal Flow

```
  Anomaly Detected (z-score >= 3.5)
           |
           v
  +-------------------+
  | Build Proposal    |  agent constructs FreezeProposal
  +-------------------+
           |
           v
  +-------------------+
  | Validate          |  check orders exist, z-score holds, confidence >= 0.85
  +-------------------+
           |
           v
  +-------------------+
  | Request Approval  |  Telegram notification to admin
  +-------------------+
           |
     human decides
     /           \
  /approve      /reject
     |              |
     v              v
  +----------+  +-----------+
  | Re-check |  | Discarded |
  | + Submit |  +-----------+
  +----------+
       |
       v
  On-chain MsgSubmitProposal
```

### Telegram Commands

Only accepted from `TELEGRAM_ADMIN_CHAT_ID`:

| Command | Action |
|---|---|
| `/approve <uuid>` | Re-validate and submit proposal to Regen governance |
| `/reject <uuid> [reason]` | Discard proposal with optional reason |
| `/pending` | List all pending proposals |

### Security

> **REGEN_MNEMONIC must never be committed to git, logged, or included in any error message or audit entry.** If exposed, rotate immediately by creating a new wallet and transferring any deposited funds.

The agent enforces:
- **No auto-approve**: Proposals expire and are discarded if not explicitly approved
- **No auto-execute**: The `can_execute: false` constraint is enforced at the code level
- **Mnemonic masking**: Any string resembling a mnemonic (12+ words) is redacted in logs and audit entries
- **Admin-only commands**: Only `TELEGRAM_ADMIN_CHAT_ID` can approve — all other chats are silently ignored

## Workflows

| Workflow | ID | Monitors | Frequency | MCP Tools Called |
|---|---|---|---|---|
| Price Anomaly Detection | WF-MM-01 | Price manipulation, z-score deviations | Every poll + on new sell orders | `get_regen_price`, `browse_available_credits` |
| Liquidity Monitoring | WF-MM-02 | Order book depth, market health | Every poll + on large trades | `check_supply_health`, `browse_available_credits` |
| Retirement Pattern Analysis | WF-MM-03 | Retirement demand signals, goal completion | Once per day + on new retirements | `get_community_goals`, `check_supply_health` |
| Curation Quality Scoring | WF-MM-04 | Listing quality, vintage freshness | Every poll | `browse_available_credits`, `check_supply_health` |

## Alert Severity Levels

| Severity | Conditions | Action |
|---|---|---|
| INFO | Community goal completed, high retirement demand | Log and notify |
| WARNING | Low credit stock, price move >10%, z-score 2.0-3.5, MCP unreachable | Notify |
| CRITICAL | Z-score >=3.5, market health <30 | Escalation (sent twice) + freeze proposal pipeline |

## Health Endpoint

```bash
curl http://localhost:3099/health
curl http://localhost:3099/state
```

## Data Persistence

| File | Contents |
|---|---|
| `data/price-history.json` | Rolling 24-point price window for z-score |
| `data/alert-state.json` | Alert cooldowns + daily counter |
| `data/market-snapshot.json` | Last market state (served from /state on startup) |
| `data/event-cursor.json` | Chain event watcher cursor |
| `data/pending-proposals/*.json` | Proposals awaiting human approval |
| `data/audit-log.jsonl` | Append-only proposal lifecycle log |

## Audit Log

Every proposal action is permanently logged in `data/audit-log.jsonl` (one JSON line per entry):

Events recorded: `proposal_created`, `proposal_validated`, `approval_requested`, `approved`, `rejected`, `expired`, `submitted`, `submission_failed`, `dry_run_completed`

Each entry: `{ timestamp, event, proposalId, actorType, data, version }`

## PM2 Deployment

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 logs regen-market-monitor
```

## Architecture

```
src/
├── index.ts                          # Entry point — wires everything
├── config.ts                         # Environment variable parsing
├── types.ts                          # Shared type definitions
├── schemas.ts                        # Zod schemas (MCP + LCD responses)
├── logger.ts                         # Pino structured JSON logger
├── mcp-client.ts                     # MCP client with retry + timeout
├── data-store.ts                     # Persistent JSON storage
├── alerts.ts                         # Alert manager with persistent dedup
├── health-server.ts                  # HTTP /health and /state endpoints
├── scheduler.ts                      # Poll loop + event integration + dedup
├── characters/
│   └── market-monitor.character.ts   # AGENT-003 character definition
├── plugins/
│   └── regen-market-plugin.ts        # Four OODA workflows
├── notifiers/
│   └── telegram.ts                   # Telegram with escalation + digest
└── chain/
    ├── lcd-client.ts                 # Regen LCD REST queries
    ├── event-watcher.ts              # Chain event poller
    ├── proposal-builder.ts           # Freeze proposal construction
    ├── proposal-submitter.ts         # On-chain tx signing (@cosmjs)
    ├── approval-gate.ts              # Human approval gate (non-negotiable)
    ├── telegram-commands.ts          # /approve, /reject, /pending handlers
    └── audit-log.ts                  # Append-only JSONL audit trail
```

## Spec Reference

- Agent: [AGENT-003 RegenMarketMonitor](https://github.com/regen-network/agentic-tokenomics/blob/main/phase-2/2.4-agent-orchestration.md)
- Workflows: [WF-MM-01 through WF-MM-04](https://github.com/regen-network/agentic-tokenomics/blob/main/phase-2/2.2-agentic-workflows.md)

## License

Apache-2.0
