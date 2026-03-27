import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../../logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WalletTier = "mega" | "large" | "medium" | "watch";

export interface WatchedWallet {
  address: string;
  label: string;
  chain: "regen" | "osmosis" | "base";
  balance_regen: number;
  balance_usd: number;
  last_seen_active: string; // ISO timestamp
  tier: WalletTier;
  tags: string[];
}

// ─── Known addresses ──────────────────────────────────────────────────────────

const KNOWN_WALLETS: Omit<WatchedWallet, "balance_regen" | "balance_usd" | "last_seen_active" | "tier">[] = [
  {
    address: "regen1v8her6lnpg5yjsmmt6p74fk6d33gq3nwqnyhfd",
    label: "Regen Foundation",
    chain: "regen",
    tags: ["foundation", "ecosystem"],
  },
  {
    address: "regen1kaut3e4lnmwme5j8gf5ck3yc0qpsh8v8g0upqt",
    label: "LPDAO",
    chain: "regen",
    tags: ["dao", "liquidity"],
  },
  {
    address: "osmo1z6wq2yjczpsda6vd50p2lacx69fhhkqnwfvz0c",
    label: "Hydrex Pool",
    chain: "osmosis",
    tags: ["pool", "dex"],
  },
  {
    address: "0x96bf25d9FcE825Ea5f926b846A4918E85bCc5909",
    label: "Aerodrome Pool",
    chain: "base",
    tags: ["pool", "dex", "aerodrome"],
  },
];

// ─── LCD endpoints per chain ──────────────────────────────────────────────────

const LCD_ENDPOINTS: Record<string, string> = {
  regen: process.env.REGEN_LCD_URL || "https://regen.api.boz.moe",
  osmosis: process.env.OSMOSIS_LCD_URL || "https://lcd.osmosis.zone",
};

const REGEN_DENOM = "uregen";
const REGEN_DECIMALS = 6;
const REGEN_PRICE_USD = parseFloat(process.env.REGEN_PRICE_USD || "0.03");

// ─── Tier thresholds (in USD) ─────────────────────────────────────────────────

function classifyTier(balanceUsd: number): WalletTier {
  if (balanceUsd > 5_000_000) return "mega";
  if (balanceUsd > 1_000_000) return "large";
  if (balanceUsd > 100_000) return "medium";
  return "watch";
}

// ─── WalletRegistry ───────────────────────────────────────────────────────────

export class WalletRegistry {
  private wallets: Map<string, WatchedWallet> = new Map();
  private filePath: string;
  private logger: Logger;

  constructor(logger: Logger, dataDir: string = "./data") {
    this.logger = logger;
    this.filePath = join(dataDir, "wallet-registry.json");
    this.loadFromDisk();
    this.seedKnownWallets();
  }

  // ─── Persistence ────────────────────────────────────────────────────

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        this.logger.info({ path: this.filePath }, "No wallet registry file found, starting fresh");
        return;
      }
      const raw = readFileSync(this.filePath, "utf-8");
      const entries: WatchedWallet[] = JSON.parse(raw);
      for (const w of entries) {
        this.wallets.set(w.address, w);
      }
      this.logger.info({ count: entries.length }, "Loaded wallet registry from disk");
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, "Failed to load wallet registry");
    }
  }

  private saveToDisk(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const tmpPath = this.filePath + ".tmp";
      const data = JSON.stringify(Array.from(this.wallets.values()), null, 2);
      writeFileSync(tmpPath, data, "utf-8");
      renameSync(tmpPath, this.filePath);
      this.logger.debug({ count: this.wallets.size }, "Saved wallet registry to disk");
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, "Failed to save wallet registry");
    }
  }

  // ─── Seed known wallets ─────────────────────────────────────────────

  private seedKnownWallets(): void {
    let added = 0;
    for (const known of KNOWN_WALLETS) {
      if (!this.wallets.has(known.address)) {
        this.wallets.set(known.address, {
          ...known,
          balance_regen: 0,
          balance_usd: 0,
          last_seen_active: new Date().toISOString(),
          tier: "watch",
        });
        added++;
      }
    }
    if (added > 0) {
      this.logger.info({ added }, "Seeded known wallets");
      this.saveToDisk();
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────

  addWallet(address: string, label: string, chain: "regen" | "osmosis" | "base"): WatchedWallet {
    const existing = this.wallets.get(address);
    if (existing) {
      this.logger.debug({ address }, "Wallet already registered, updating label");
      existing.label = label;
      existing.chain = chain;
      this.saveToDisk();
      return existing;
    }

    const wallet: WatchedWallet = {
      address,
      label,
      chain,
      balance_regen: 0,
      balance_usd: 0,
      last_seen_active: new Date().toISOString(),
      tier: "watch",
      tags: [],
    };
    this.wallets.set(address, wallet);
    this.saveToDisk();
    this.logger.info({ address, label, chain }, "Added wallet to registry");
    return wallet;
  }

  getAll(): WatchedWallet[] {
    return Array.from(this.wallets.values());
  }

  getTopByBalance(limit: number): WatchedWallet[] {
    return Array.from(this.wallets.values())
      .sort((a, b) => b.balance_usd - a.balance_usd)
      .slice(0, limit);
  }

  getByAddress(address: string): WatchedWallet | undefined {
    return this.wallets.get(address);
  }

  // ─── Balance refresh ────────────────────────────────────────────────

  async refreshBalances(): Promise<void> {
    this.logger.info({ count: this.wallets.size }, "Refreshing wallet balances");
    let updated = 0;
    let errors = 0;

    for (const wallet of Array.from(this.wallets.values())) {
      try {
        const balanceRegen = await this.queryBalance(wallet.address, wallet.chain);
        const balanceUsd = balanceRegen * REGEN_PRICE_USD;
        const prevTier = wallet.tier;

        wallet.balance_regen = balanceRegen;
        wallet.balance_usd = balanceUsd;
        wallet.tier = classifyTier(balanceUsd);
        wallet.last_seen_active = new Date().toISOString();

        if (prevTier !== wallet.tier) {
          this.logger.info(
            { address: wallet.address, label: wallet.label, prevTier, newTier: wallet.tier },
            "Wallet tier changed"
          );
        }

        updated++;
      } catch (err) {
        errors++;
        this.logger.warn(
          { address: wallet.address, chain: wallet.chain, error: (err as Error).message },
          "Failed to refresh balance"
        );
      }
    }

    this.saveToDisk();
    this.logger.info({ updated, errors }, "Balance refresh complete");
  }

  // ─── LCD balance query ──────────────────────────────────────────────

  private async queryBalance(address: string, chain: "regen" | "osmosis" | "base"): Promise<number> {
    if (chain === "base") {
      // Base chain (EVM) — skip for now, would need ethers or ERC-20 call
      this.logger.debug({ address, chain }, "Skipping Base chain balance query (EVM not implemented)");
      return 0;
    }

    const lcdBase = LCD_ENDPOINTS[chain];
    if (!lcdBase) {
      this.logger.warn({ chain }, "No LCD endpoint configured for chain");
      return 0;
    }

    const denom = chain === "regen" ? REGEN_DENOM : "uregen"; // IBC denom on Osmosis would differ
    const url = `${lcdBase}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${denom}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LCD balance query failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as { balance?: { denom?: string; amount?: string } };
    const rawAmount = json.balance?.amount ?? "0";
    return parseInt(rawAmount, 10) / Math.pow(10, REGEN_DECIMALS);
  }
}
