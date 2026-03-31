# The Autonomous REGEN Agent

## Vision

This is THE trading agent for Regen Network. It stores all profits in REGEN. It bootstraps from free compute, acquires REGEN through profitable trading, and retires ecocredits from surplus. It gets smarter as inference gets cheaper.

Not a portfolio tracker. Not a dashboard. An autonomous agent that accumulates REGEN through real market operations.

## Phase 0: Free Bootstrap ($0)

- Deploy agent on VPS (already done)
- Start mining on Litcoin using free inference (OpenRouter Qwen or Litcoin's own allocation)
- Earn LITCREDIT from mining → use for AI inference scoring
- Zero capital required. Agent bootstraps from free compute.

## Phase 1: First REGEN ($0 → first acquisition)

- Use earned LITCREDIT for inference to score REGEN markets
- Cross-chain scanner identifies cheapest venue
- First buy: acquire REGEN on cheapest venue
- Capital: mining rewards surplus or minimal seed ($5-20 USDC on Base)

## Phase 2: Arb Hunting

- Monitor all venues for price discrepancies
- Base is home — deepest liquidity, lowest gas
- Cross-chain arb: buy cheap on Osmosis → IBC bridge → sell on Base (or reverse)
- CEX/DEX arb: Coinstore listing creates persistent spread vs Base DEXes
- All profits stay in REGEN. Never sell below cost basis.

## Phase 3: Position Trading

- AI scoring identifies momentum plays (Hydrex epoch transitions, Aerodrome gauge votes, LP incentive shifts)
- Take positions ahead of anticipated pumps
- Risk: never more than 20% of holdings per position
- Store of value: REGEN. Profits compound.

## Phase 4: Retirement Flywheel

- Cumulative profits exceed floor → route surplus to ecocredit retirement
- On-chain memo: "Retired by regen-market-monitor contributors"
- Retired credits = permanent ecological impact
- Visible on Regen explorer → attracts contributors → more venues → more profits

## Phase 5: Self-Improving

- Track signal accuracy vs actual price movement
- Auto-tune thresholds from backtest performance
- New venues added via contributor PRs
- Cheaper inference = more trades scored = more profits

## Architecture

- **Home chain**: Base (deepest liquidity, cheapest gas)
- **Inference**: LITCREDIT relay (mined free via Litcoin)
- **Execution**: Server-side wallet (no browser connection needed)
- **Store of value**: ALL profits held in REGEN
- **Surplus**: Excess profits retire ecocredits on-chain

## What Exists vs What's Needed

| Component | Status | Next Step |
|---|---|---|
| Cross-chain price aggregator | Built (5 venues) | Fix Osmosis + Hydrex clients |
| Signal engine | Built (10 types) | Working |
| Trading signal composer | Built | Working |
| Arbitrage detector | Built | Working |
| Surplus router | Built | Working |
| Retirement attribution | Built | Wire on-chain execution |
| Public dashboard | Built | Just rebuilt |
| Venue plugin template | Built | Accepting PRs |
| CONTRIBUTING.md | Built | Live |
| Litcoin mining | Built (MVP repo) | Route earned LC here |
| Base wallet execution | Not built | Need ethers.js signer |
| Osmosis IBC execution | Not built | Need IBC transfer |
| Coinstore CEX adapter | Not built | Need API integration |
| Free inference bootstrap | Not built | OpenRouter/Qwen integration |
| Position management | Not built | Entry/exit/stop-loss logic |

## The Flywheel

Free compute → LITCREDIT → AI scoring → identify cheap REGEN → buy → hold → trade profits → accumulate more REGEN → surplus → retire ecocredits → on-chain proof → attract contributors → more venues → more arb → more profits → more REGEN → more retirements

The agent gets stronger over time. Inference gets cheaper. REGEN gets scarcer (retirements remove supply). The game compounds.
