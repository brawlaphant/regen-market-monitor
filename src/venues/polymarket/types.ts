/**
 * Polymarket venue types.
 */

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  markets: PolymarketMarket[];
}

export interface PolymarketMarket {
  id: string;
  question: string;
  outcomePrices?: string;
  outcomes?: string;
  volume: string;
  liquidity: string;
  active: boolean;
  closed: boolean;
  conditionId: string;
  endDate?: string;
}

export interface ScoredMarket {
  question: string;
  slug: string;
  crowdYes: number;
  aiYes: number;
  divergence: number;
  direction: "BUY_YES" | "BUY_NO";
  betSize: number;
  liquidity: number;
  category?: string;
  source?: string;
  /** CLOB condition token ID for the relevant outcome (YES or NO token) */
  tokenId?: string;
  /** Bid-ask spread as a fraction (e.g., 0.03 = 3%) */
  spread?: number;
}

/** Category patterns for market classification */
export const CATEGORY_PATTERNS: Record<string, RegExp> = {
  geopolitics: /\b(war|conflict|invasion|nato|sanctions|military|coup|treaty|ceasefire|nuclear|territory|border|diplomacy|election|president|prime minister|vote|parliament|congress|senate|government)\b/i,
  ai: /\b(ai|artificial intelligence|gpt|llm|openai|anthropic|google ai|deepmind|agi|machine learning|neural|chatbot|copilot|model|training)\b/i,
  climate: /\b(climate|carbon|emissions|temperature|warming|renewable|solar|wind|ev|electric vehicle|paris agreement|cop\d|methane|biodiversity|deforestation|sea level|drought|wildfire)\b/i,
  crypto: /\b(bitcoin|ethereum|btc|eth|crypto|blockchain|defi|nft|token|stablecoin|solana|base|layer.?2|halving|etf|sec|regulation)\b/i,
};

export function categorizeMarket(question: string): string | null {
  for (const [category, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(question)) return category;
  }
  return null;
}
