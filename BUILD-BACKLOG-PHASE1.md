# RMM Build Backlog — Phase 1

Ship the foundation: parent wallet data feeds into RMM signal pipeline. Both repos stay in sync with Regen Network governance.

**Phase Timeline:** 2026-04-06 → 2026-04-20 (2 weeks)  
**Phase Dependency:** RESEARCH-BACKLOG.md Phase 0-1 (RX1-RX11)  
**Ship Gate:** Parent ledger + RMM adapter live, first parent→RMM trade executed

---

## Priority 1: Parent Wallet Integration (Must Ship This Week)

| ID | Build Item | Acceptance Criteria | Owner | Status |
|---|---|---|---|---|
| B1.1 | `/api/parent/ledger` endpoint | Returns JSON: trades[], prices{}, yields, gas. Within 1 block of on-chain. Rate limit: 10 req/min. | You | Ready |
| B1.2 | `src/venues/base-ecowealth/` adapter | New venue adapter. Imports parent ledger. Signals: liquidity, mid-price, REGEN flow. | You | Ready |
| B1.3 | Wire parent feed into pipeline | RMM main loop: fetch parent ledger → base-ecowealth adapter → merge with GMX/HL/PM signals | You | Ready |
| B1.4 | Live signal dashboard widget | Show parent Base trades in real-time on RMM public dashboard. Latency <5s. | You | Ready |
| B1.5 | Unit tests: parent adapter | Mock parent ledger. Verify: parses trades, handles missing data, ignores stale prices. | You | Ready |

---

## Priority 2: Bankr Integration (Ship in Parallel, Week 1)

| ID | Build Item | Acceptance Criteria | Owner | Status |
|---|---|---|---|---|
| B2.1 | Audit Bankr API response types | Document: HL orders, PM bets, rate limits, execution latency. Create `src/execution/bankr-types.ts` | You | Ready |
| B2.2 | Bankr order adapter | Parse Bankr responses. Convert to RMM signal format. Test with paper orders first. | You | Ready |
| B2.3 | Sentinel → RMM feedback loop | After Bankr executes, send execution result back to RMM state. Update signal confidence. | You | Ready |
| B2.4 | Paper trading mode for Bankr | DRY_RUN=true. Execute to paper ledger, don't send to exchange. Baseline for live. | You | Ready |

---

## Priority 3: REGEN Accumulation Logic (Ship Week 2)

| ID | Build Item | Acceptance Criteria | Owner | Status |
|---|---|---|---|---|
| B3.1 | REGEN buy trigger model | When parent WETH profit > threshold, trigger REGEN purchase. Thresholds configurable in env. | You | Ready |
| B3.2 | Multi-venue REGEN execution | Parent trades best REGEN venue (CoinGecko → Osmosis → Base → Regen order). 2% slippage max. | You | Ready |
| B3.3 | REGEN flow tracker | RMM dashboard shows: daily REGEN purchased, avg price, cumulative stack, yield. | You | Ready |
| B3.4 | Yield reinvestment autopilot | Track REGEN staking yield. Auto-buy more REGEN or rotate to mission credits. Configurable split. | You | Ready |

---

## Priority 4: AGENT-003 Proposal Groundwork (Ship Week 2)

| ID | Build Item | Acceptance Criteria | Owner | Status |
|---|---|---|---|---|
| B4.1 | `src/governance/proposal-builder.ts` | Build FreezeProposal/EmergencyStop/ParameterChange messages. Validate Regen chain spec. | You | Ready |
| B4.2 | Proposal confidence gate | Only propose if z-score >= 3.5 AND confidence >= 0.85. Else hold for manual review. | You | Ready |
| B4.3 | Telegram approval flow | Send proposal draft to admin. Await /approve or /reject. Execute if approved. | You | Ready |
| B4.4 | On-chain proposal submission | Sign + submit proposal to Regen LCD. Track vote progress. Update dashboard. | You | Ready |

---

## Risk Gates (Must Pass Before Shipping to Prod)

| Risk | Gate | Verification |
|---|---|---|
| **Parent ledger stale data** | Ledger state must match parent-trader.ts within 1 block | Compare /api/parent/ledger to on-chain state via RPC |
| **Bankr execution failed silently** | Every Bankr order tracked in RMM state. Paper ledger shows execution or error. | Check paper ledger against Bankr API response |
| **REGEN slippage exceeded** | Never execute if slippage > 2%. Abort buy, log alert. | Test with CoinGecko + Osmosis quotes, verify slippage check |
| **Proposal rejected by chain** | Dry-run proposal validation before submitting. Simulate gas. | Use cosmwasm-simulate or dry-run endpoint |
| **Signal merge conflicts** | Parent signals don't override GMX/HL/PM. They coexist as separate venue. | Unit test: merge 3 parent signals + 3 GMX signals, verify all present |

---

## Acceptance Criteria Format (Per Item)

Example (B1.1):

```
ITEM: B1.1 — /api/parent/ledger endpoint

ACCEPTANCE CRITERIA:
  ✓ GET /api/parent/ledger returns JSON with:
    - trades[]: { timestamp, symbol, side, size, price, fee, pnl }
    - prices: { LITCOIN, WETH, REGEN, ECO, USDC (in USD) }
    - yields: { litcoin_mined_today, staking_yield_24h }
    - gas_spent_24h: number (in ETH)
    - metadata: { last_trade, wallet, timestamp }
  ✓ Latency < 100ms (cached, updates every block)
  ✓ Rate limit: 10 req/min per IP
  ✓ Field values match parent-trader.ts state within 1 block
  
TEST CASES:
  ✓ fetch ledger, verify all fields present
  ✓ compare LITCOIN price to parent's last trade entry
  ✓ verify REGEN yield = parent's staking balance * (annual_rate / 365)
  ✓ rate limit: 11 requests in 60s → 429 on 11th
  ✓ stale data: if parent-trader is down, endpoint returns 202 (accepted, returning cached)

GATE:
  ✓ Must pass on staging VPS before deploying to prod
  ✓ Parent state and endpoint state must stay in sync (< 5min drift)
```

---

## Deployment Checklist

Before each item ships to prod:

- [ ] All tests pass locally + CI
- [ ] Risk gate passes (see Risk Gates table)
- [ ] Monitoring alerts configured (for this feature)
- [ ] Rollback procedure documented
- [ ] No silent failures (log everything)

---

## How to Start

1. Pick **B1.1** — implement /api/parent/ledger
2. Run tests locally
3. Deploy to staging VPS
4. Verify against parent-trader.ts state
5. Mark as `shipped: staging`
6. Move to B1.2
7. Once all B1.* pass gates → ship to prod together

Then B2.* and B3.* in parallel.

---

## Metrics to Track

| Metric | Target | Current |
|---|---|---|
| Parent ledger endpoint latency | <100ms | TBD |
| Parent→RMM data freshness | <2s | TBD |
| Bankr order execution rate | >98% | TBD |
| REGEN purchase frequency | 1x/day avg | TBD |
| Proposal approval latency | <5min | TBD |
| Signal merge conflicts | 0 | TBD |

---

## Open Questions Before Shipping

- [ ] RX1: How should parent push data vs RMM pull? WebSocket, polling, push HTTP?
- [ ] RX2: Should Bankr wallet trade same venues as parent, or different (HL/PM only)?
- [ ] RX3: Which REGEN venue should parent prioritize? (CoinGecko > Osmosis > Base > Regen)
- [ ] RX4: What's the minimum proposal confidence threshold? 0.85? 0.95?
- [ ] RX5: At what LITCREDIT cost does edge disappear? Model this before B4.*

Resolve these before week 2 ships.
