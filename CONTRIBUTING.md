# Contributing to regen-market-monitor

## What this project does

This is an autonomous trading agent that earns money to fund ecological regeneration. It scans markets across multiple venues (Polymarket, Hyperliquid, GMX, Regen on-chain), generates trading signals, executes trades (or paper trades), and routes surplus profits to REGEN token accumulation and ecocredit retirement. Every AI inference call burns LITCREDIT tokens, creating structural demand for the compute network. The more venues we add, the more the agent can earn, and the more ecological credits get retired.

## How to add a venue

The highest-impact contribution is adding a new trading venue. We have a ready-to-use template that gets you from zero to working PR in about 20 minutes.

### Quick version

```bash
# 1. Clone and set up
git clone https://github.com/brawlaphant/regen-market-monitor.git
cd regen-market-monitor
npm install

# 2. Copy the venue template
cp -r src/venues/_template src/venues/your-venue

# 3. Follow the step-by-step guide
#    Open src/venues/_template/README.md — it walks you through everything
```

### Detailed guide

See **[src/venues/_template/README.md](src/venues/_template/README.md)** for the complete step-by-step walkthrough, including:
- How to replace the placeholders
- How to define your types
- How to write and test a strategy
- How to wire into the orchestrator

### Current venues

| Venue | Directory | What it does |
|---|---|---|
| **Polymarket** | `src/venues/polymarket/` | Prediction markets — 4 AI-scored strategies (Spray, Worldview, Contrarian, Closer) |
| **Hyperliquid** | `src/venues/hyperliquid/` | Perp futures — funding rate capture + 24h momentum |
| **GMX** | `src/venues/gmx/` | Perp futures on Arbitrum — funding, OI momentum, GM pool yield |

### Venues we want

These are valuable additions. If you know any of these protocols, pick one and build it.

| Venue | Chain | Why |
|---|---|---|
| **Kujira FIN** | Kujira | Order-book DEX with liquidation bids. Native REGEN/USDC pair is possible. |
| **Shade Protocol** | Secret Network | Private DeFi with ShadeSwap. Unique because trades are private by default. |
| **Osmosis CL Pools** | Osmosis | Concentrated liquidity with REGEN/OSMO pool. Fee capture from LP positions. |
| **Injective** | Injective | On-chain order book perps with zero gas and built-in oracle. |
| **Astroport** | Neutron | Multi-chain AMM with concentrated liquidity pools. |
| **Levana** | Osmosis/Sei | Cosmos-native perpetuals with well-funded positions. |

## How to run tests

```bash
# Run all tests
npm test

# Run tests in watch mode (re-runs on file change)
npm run test:watch

# Run a specific test file
npx vitest run tests/unit/gmx-strategies.test.ts

# Run tests with coverage report
npm run test:coverage
```

Coverage thresholds (enforced in CI):
- Lines: 75%
- Functions: 80%
- Branches: 70%

## How to build

```bash
npm run build        # TypeScript compile (tsc)
npm run dev          # Run with tsx (hot reload)
npm run lint         # ESLint
```

## Project structure

```
src/
  venues/              # <-- This is where you add venues
    _template/         # Copy this to start a new venue
    gmx/               # GMX V2 on Arbitrum
    hyperliquid/       # Hyperliquid perps
    polymarket/        # Polymarket prediction markets
  strategies/
    multi-venue-orchestrator.ts   # Runs all venues in parallel
  scoring/
    litcredit-provider.ts         # AI scoring via LITCREDIT relay
  surplus/
    surplus-router.ts             # Routes trading surplus to REGEN
  logger.ts            # Pino logger (use this, not console.log)
  types.ts             # Core platform types
tests/
  unit/                # Unit tests (one per module)
  integration/         # Integration tests
  fixtures/            # Shared test data
```

## How to submit a PR

1. **Fork the repo** and create a branch from `main`:
   ```bash
   git checkout -b venue/your-venue-name
   ```

2. **Implement your venue** following the template guide.

3. **Make sure everything passes:**
   ```bash
   npm run build
   npm test
   ```

4. **Push and open a PR** against `main`:
   ```bash
   git push origin venue/your-venue-name
   ```
   Then open a PR on GitHub. Title format: `feat: add [Venue Name] venue`

### PR checklist

- [ ] All four venue files exist: `index.ts`, `types.ts`, `strategies.ts`, `ledger.ts`
- [ ] All `%%PLACEHOLDER%%` values have been replaced
- [ ] At least one strategy function is implemented (not just the skeleton)
- [ ] Unit tests exist for strategies (mock the SDK, don't call real APIs)
- [ ] Unit tests exist for ledger (load/save/corrupt recovery)
- [ ] `npm run build` succeeds with no type errors
- [ ] `npm test` passes (all existing tests still green)
- [ ] `dryRun` defaults to `true` in config builder
- [ ] No secrets, API keys, or private keys in committed code

### What makes a good venue PR

- **One strategy is enough.** Get one working well. More can come in follow-up PRs.
- **Mock the SDK in tests.** Define a `SdkLike` interface. Tests should never call real APIs.
- **Handle errors gracefully.** Strategy functions return `[]` on error, never throw.
- **Sort signals by strength.** Return the top 5, best first.
- **Include a rationale.** Every signal should have a human-readable `rationale` string explaining why.

## Code style

- TypeScript strict mode
- ES modules (`.js` extensions in imports, even for `.ts` files)
- Pino for logging (structured JSON, not console.log)
- Vitest for tests
- No default exports
- Prefer `const` over `let`

## License

Apache-2.0. See [LICENSE](LICENSE) for details.
