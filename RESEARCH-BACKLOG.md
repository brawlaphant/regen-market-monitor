# RMM Research Backlog

Deep research queue for Regen Market Monitor. Each research item feeds a build phase.

**Current Date:** 2026-04-06  
**Goal:** Wire EcoWealth parent Base trader data into RMM; expand multi-venue trading; prep AGENT-003 for Regen Network governance role.

---

## Phase 0: Foundation Research (Weeks 1-2)

| # | Item | Depth | Output | Status |
|---|---|---|---|---|
| RX1 | **Parent wallet → RMM data contract** | Deep | Design: how parent Base ledger feeds RMM venue signals. What data? What latency? Pull vs push? | Ready |
| RX2 | **Bankr + parent trader integration model** | Deep | Map: Bankr (HL+PM) vs parent (Base spot). Where do they overlap? Separate signals or unified? | Ready |
| RX3 | **Cross-chain REGEN liquidity depth map** | Deep | Audit: REGEN on Regen, Osmosis, Base, CoinGecko. Where is it liquid? Where are the spreads? Which venues for accumulation? | Ready |
| RX4 | **On-chain action layer scope** | Deep | Define: what can AGENT-003 propose vs execute? Fee authority? Market intervention? Pause authority? | Ready |
| RX5 | **AI inference cost vs edge analysis** | Deep | Model: at what AI cost/inference does trading edge disappear? When does LITCREDIT burn exceed profit? | Ready |
| RX6 | **Multi-venue signal correlation** | Deep | Research: GMX funding + HL momentum + PM sentiment + REGEN flow — how correlated? When to trust each? | Ready |

---

## Phase 1: Parent Wallet Integration (Weeks 3-5)

| # | Item | Depth | Output | Status |
|---|---|---|---|---|
| RX7 | **Parent ledger API spec** | Medium | Spec: what does `GET /api/parent/ledger` return? Trades, prices, gas spent, REGEN yields? | Ready |
| RX8 | **RMM venue adapter for parent Base data** | Medium | Code: new `src/venues/base-ecowealth/` adapter. Parses parent trades, feeds signal pipeline. | Ready |
| RX9 | **Price feed prioritization** | Medium | Decision: parent on-chain prices vs external APIs. Fallback chain? Latency SLA? | Ready |
| RX10 | **REGEN accumulation trigger model** | Medium | Research: when parent's WETH profits should flip to REGEN buys. Size? Frequency? Threshold? | Ready |
| RX11 | **Spawn swarm + RMM coordination** | Medium | Design: how 49 spawns inform RMM's signal pipeline. Do they trade same venues? Pool signals? | Ready |

---

## Phase 2: Bankr Execution Wiring (Weeks 6-7)

| # | Item | Depth | Output | Status |
|---|---|---|---|---|
| RX12 | **Bankr API integration audit** | Medium | Audit: Bankr's HL+Polymarket APIs. Rate limits? Execution speed? Minimum sizes? | Ready |
| RX13 | **Sentinel trader → RMM bridge** | Medium | Design: how does Bankr sentinel (from MVP) feed signals back into RMM? Shared state? | Ready |
| RX14 | **Multi-wallet execution model** | Deep | Decision: parent key + Bankr key + spawned keys. Who trades what? Risk limits per wallet? | Ready |
| RX15 | **Fee bleed analysis** | Medium | Model: Bankr fees + RMM trading costs. At what capital does fee make profit impossible? | Ready |

---

## Phase 3: AGENT-003 Governance (Weeks 8-10)

| # | Item | Depth | Output | Status |
|---|---|---|---|---|
| RX16 | **Proposal design patterns** | Deep | Spec: what FreezeProposal/EmergencyStop/ParameterChange look like. Regen chain submission. | Ready |
| RX17 | **Signal→Proposal confidence threshold** | Medium | Decision: what z-score/confidence triggers proposal? When to wait for human approval? | Ready |
| RX18 | **Governance vote monitoring** | Medium | Spec: how RMM tracks vote progress. Executes on-chain action when vote passes? | Ready |
| RX19 | **Emergency authority scope** | Deep | Research: what powers can AGENT-003 exercise? What needs DAO approval? What's autonomous? | Ready |
| RX20 | **Cross-chain settlement** | Medium | Design: if proposal passes on Regen, how does it execute on other chains (Osmosis, Base, Arb)? | Ready |

---

## Phase 4: Profitability + Sustainability (Weeks 11-13)

| # | Item | Depth | Output | Status |
|---|---|---|---|---|
| RX21 | **P&L attribution model** | Deep | Design: how to track which agent (parent/bankr/spawned/RMM) contributed to profit/loss. | Ready |
| RX22 | **LITCREDIT burn vs edge accounting** | Medium | Model: daily inference costs in LITCREDIT. Compare to trading edge. At scale, is it profitable? | Ready |
| RX23 | **Credit retirement automation** | Medium | Spec: when RMM profits should auto-retire credits on Regen. Size? Frequency? | Ready |
| RX24 | **Yield reinvestment strategy** | Deep | Design: REGEN staking yield + mining yield + trading profits. What % to principal? What % to missions? | Ready |

---

## Phase 5: Scaling + Edge Research (Weeks 14-16)

| # | Item | Depth | Output | Status |
|---|---|---|---|---|
| RX25 | **Multi-market signal synthesis** | Deep | Research: GMX v2 + HL funding + PM sentiment + Polymarket options + Regen credit flow. What's the unified edge? | Ready |
| RX26 | **Liquidity provision strategy** | Deep | Design: should RMM provide LP on Base/Osmosis REGEN pairs? Risk? Reward? Burned LP governance? | Ready |
| RX27 | **Whale tracker + front-running defense** | Medium | Spec: monitor large REGEN moves. Alert before MEV. Execution sequence to minimize slippage. | Ready |
| RX28 | **Seasonal + macro signal layer** | Medium | Research: does REGEN trade with seasons? ETH cycle? Macro sentiment? Model it. | Ready |

---

## Research Output Format

Each research item **must produce:**

1. **Decision log** — what was decided + why (e.g., "parent pushes data, RMM pulls — latency <2s, avoids coupling")
2. **Architecture diagram** — if it involves systems integration
3. **Code spec** — pseudocode or interface definitions
4. **Risk/mitigation** — what could go wrong? How to defend?
5. **Open questions** — what's still TBD for next phase?

---

## How This Feeds Build Backlog

After each research phase completes, we create a **BUILD-BACKLOG-PHASEx.md** with:

- **One build item per research finding**
- **Clear acceptance criteria** (tests, deployment gates, monitoring)
- **Risk gates** (gate must pass before shipping to prod)
- **P&L impact estimate** (how much does this feature move the needle?)

Example:

```
RESEARCH: RX7 → Parent Ledger API Spec
BUILD: B7 → Implement /api/parent/ledger endpoint
  - AC: returns trades, prices, REGEN yields in JSON
  - Test: fetch ledger, verify fields, compare to on-chain state
  - Gate: ledger must match parent-trader.ts state within 1 block
  - Impact: unlocks RMM to consume live parent data
```

---

## Timeline

- **By 2026-04-20:** Phase 0 + Phase 1 research done, BUILD-BACKLOG-PHASE1 ready
- **By 2026-05-04:** Phases 2-3 done, parent + Bankr wiring live
- **By 2026-05-18:** Phase 4 done, profitability model proven
- **By 2026-06-01:** Phase 5 done, multi-market edge validated, Regen govenance authority finalized

Then we ship to mainnet and get paid.
