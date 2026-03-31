# How to Add a New REGEN Venue in 20 Minutes

This template gives you a working venue skeleton. Copy it, fill in the TODOs, and submit a PR.

## Prerequisites

- Node.js >= 20
- This repo cloned and `npm install` done
- Tests pass: `npm test`

## Step-by-step

### 1. Copy the template (2 min)

```bash
cp -r src/venues/_template src/venues/your-venue
```

Replace `your-venue` with a lowercase slug (e.g. `kujira`, `shade`, `osmosis-cl`, `injective`).

### 2. Find and replace placeholders (3 min)

Open all four files in `src/venues/your-venue/` and replace:

| Placeholder | Replace with | Example |
|---|---|---|
| `%%VENUE_NAME%%` | PascalCase venue name | `Kujira` |
| `%%VENUE_KEY%%` | UPPER_SNAKE env prefix | `KUJIRA` |
| `%%venue_key%%` | lowercase slug (matches directory name) | `kujira` |

Quick way with sed:

```bash
cd src/venues/your-venue
sed -i '' 's/%%VENUE_NAME%%/Kujira/g; s/%%VENUE_KEY%%/KUJIRA/g; s/%%venue_key%%/kujira/g' *.ts
```

### 3. Define your types (3 min)

Edit `types.ts`:

1. **Signal** — Replace the generic `strategy: string` with a union of your strategy names (e.g. `"funding" | "spread_capture"`). Add any strategy-specific numeric fields (e.g. `spread_pct?: number`).
2. **Config** — Add venue-specific fields (e.g. `rpcUrl`, `chainId`, `apiBaseUrl`, `minLiquidity`).
3. **Ledger** — Usually no changes needed. The default shape works for all venues.

### 4. Write your first strategy (8 min)

Edit `strategies.ts`:

1. **Define `SdkLike`** — A minimal interface matching what you need from the venue's SDK or API. Only include methods your strategies call. This is critical for testability: your tests will mock this interface instead of importing the real SDK.

2. **Rename `scanExample`** to something meaningful (e.g. `scanFunding`, `scanSpreads`, `scanArbs`).

3. **Implement the scan logic:**
   - Fetch data from the SDK
   - Loop through markets/pairs
   - Apply your filter (threshold, volume, etc.)
   - Push signals that pass
   - Sort by signal strength
   - Return top 5

Look at real examples:
- `gmx/strategies.ts` — scanFunding (funding rate), scanMomentum (OI imbalance)
- `hyperliquid/strategies.ts` — scanFunding, scanMomentum
- `polymarket/strategies.ts` — runSpray, runWorldview, runContrarian, runCloser

### 5. Update the index (2 min)

Edit `index.ts`:

1. Update the docblock with a real description.
2. Change `export { scanExample }` to export your actual strategy function names.
3. Add any venue-specific env vars to `buildConfig()`.

### 6. Write tests (5 min)

Create `tests/unit/your-venue-strategies.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scanYourStrategy } from "../../src/venues/your-venue/strategies.js";
import type { YourVenueConfig } from "../../src/venues/your-venue/types.js";
import type { SdkLike } from "../../src/venues/your-venue/strategies.js";
import type { Logger } from "../../src/logger.js";

function mockLogger(): Logger {
  return {
    info: () => {}, warn: () => {}, error: () => {},
    debug: () => {}, fatal: () => {}, trace: () => {},
    child: () => mockLogger(), level: "silent",
  } as unknown as Logger;
}

const defaultConfig: YourVenueConfig = {
  dryRun: true,
  dailyCap: 50,
  maxPosition: 25,
  maxLeverage: 1,
  // ... your venue-specific defaults
};

// Build a mock SDK that returns controlled data
function makeSdk(/* your params */): SdkLike {
  return {
    // Return mock data matching your SdkLike interface
  };
}

describe("YourVenue strategies", () => {
  it("detects a signal when criteria are met", async () => {
    const sdk = makeSdk(/* data that should trigger a signal */);
    const signals = await scanYourStrategy(sdk, defaultConfig, mockLogger());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].direction).toBeDefined();
  });

  it("returns empty when no opportunities", async () => {
    const sdk = makeSdk(/* data that should NOT trigger */);
    const signals = await scanYourStrategy(sdk, defaultConfig, mockLogger());
    expect(signals).toHaveLength(0);
  });

  it("handles SDK error gracefully", async () => {
    const sdk = { /* methods that throw */ } as unknown as SdkLike;
    const signals = await scanYourStrategy(sdk, defaultConfig, mockLogger());
    expect(signals).toHaveLength(0); // no crash, just empty
  });
});
```

Also create `tests/unit/your-venue-ledger.test.ts` (copy from `tests/unit/gmx-ledger.test.ts`, change the import and subdirectory name).

### 7. Wire into the orchestrator (3 min)

Edit `src/strategies/multi-venue-orchestrator.ts`:

1. Add imports at the top:
```typescript
import {
  scanYourStrategy,
  loadLedger as yourVenueLoadLedger,
  saveLedger as yourVenueSaveLedger,
  buildYourVenueConfig,
} from "../venues/your-venue/index.js";
import type { YourVenueSignal } from "../venues/your-venue/types.js";
```

2. Add a `runYourVenue()` private method (follow the pattern of `runGmx()` or `runHyperliquid()`).

3. Add it to the `Promise.allSettled()` call in `run()` and handle the result.

### 8. Verify

```bash
npm run build          # TypeScript compiles
npm test               # All tests pass (including yours)
```

## File checklist

After completing all steps, your venue directory should contain:

```
src/venues/your-venue/
  index.ts       — re-exports + config builder
  types.ts       — Signal, Ledger, Config interfaces
  strategies.ts  — one or more scan functions
  ledger.ts      — load/save daily trade ledger

tests/unit/
  your-venue-strategies.test.ts
  your-venue-ledger.test.ts
```

## Tips

- **Start signal-only.** Every venue starts as signal-only (no execution). Get the scan logic right first.
- **Mock the SDK in tests.** Define `SdkLike` as the minimal interface. Never import the real SDK in tests.
- **Keep signals sorted.** Return the top 5, sorted by signal strength. The orchestrator trusts this.
- **Use `logger.warn` for SDK errors.** Never throw from a strategy function. Return empty array on error.
- **Atomic ledger writes.** Always write to `.tmp` first, then `fs.renameSync`. This prevents corruption.
- **Dry run by default.** `dryRun` must default to `true`. Nobody should lose money because they forgot a flag.

## Venue ideas

These are high-value venues that don't have implementations yet:

| Venue | Chain | Why it's interesting |
|---|---|---|
| **Kujira FIN** | Kujira | Order-book DEX, liquidation bids, native REGEN/USDC pair possible |
| **Shade Protocol** | Secret Network | Private DeFi, ShadeSwap, stkd-SCRT yield |
| **Osmosis CL Pools** | Osmosis | Concentrated liquidity, REGEN/OSMO pool, fee capture |
| **Injective** | Injective | Order-book perps, zero gas, built-in oracle |
| **Astroport** | Terra/Neutron | Multi-chain AMM, PCL pools |
| **Levana** | Osmosis/Sei | Cosmos-native perps with well-funded positions |
