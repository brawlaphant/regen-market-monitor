/**
 * LITCREDIT Scoring Provider
 *
 * AI scoring backend powered by the Litcoin relay network.
 * Every scoring call burns LITCREDIT on-chain — the agent pays for its own intelligence.
 *
 * Used by:
 * - Polymarket strategies (probability scoring)
 * - Regen market analysis (signal composition)
 * - General-purpose AI reasoning
 */

import type { RelayClient } from "../litcoin/relay-client.js";
import type { Logger } from "../logger.js";

export class LitcreditScorer {
  private relay: RelayClient;
  private logger: Logger;

  constructor(relay: RelayClient, logger: Logger) {
    this.relay = relay;
    this.logger = logger;
  }

  /**
   * Score a prediction market's true probability.
   * Returns 0-1 probability or null if scoring fails.
   */
  async scoreProbability(question: string, crowdYes: number): Promise<number | null> {
    const prompt = `You are a prediction market analyst. A market asks: "${question}"
The current crowd price is ${(crowdYes * 100).toFixed(1)}% YES.

Estimate the TRUE probability of YES as a number between 0 and 100. Consider base rates, recent evidence, and common biases. Reply with ONLY a number (e.g. "42.5"). No explanation.`;

    const raw = await this.relay.chatCompletion(
      [{ role: "user", content: prompt }],
      { maxTokens: 20, temperature: 0.3, purpose: "polymarket_scoring" }
    );

    if (!raw) return null;
    const num = parseFloat(raw);
    if (isNaN(num) || num < 0 || num > 100) return null;
    return num / 100;
  }

  /**
   * Score a prediction market with additional context (news, analysis).
   */
  async scoreProbabilityWithContext(
    question: string,
    crowdYes: number,
    context: string
  ): Promise<number | null> {
    const prompt = `You are a prediction market analyst. A market asks: "${question}"
The current crowd price is ${(crowdYes * 100).toFixed(1)}% YES.

Additional context:
${context}

Estimate the TRUE probability of YES as a number between 0 and 100. Consider base rates, the context above, and common biases. Reply with ONLY a number (e.g. "42.5"). No explanation.`;

    const raw = await this.relay.chatCompletion(
      [{ role: "user", content: prompt }],
      { maxTokens: 20, temperature: 0.3, purpose: "polymarket_scoring" }
    );

    if (!raw) return null;
    const num = parseFloat(raw);
    if (isNaN(num) || num < 0 || num > 100) return null;
    return num / 100;
  }

  /**
   * Generate context headlines for a market question.
   */
  async generateContext(question: string): Promise<string | null> {
    return this.relay.chatCompletion(
      [{
        role: "user",
        content: `Given this prediction market question: "${question}" — list 3 recent news headlines relevant to resolving it. Be factual, one per line.`,
      }],
      { maxTokens: 200, temperature: 0.4, purpose: "context_generation" }
    );
  }

  /**
   * General-purpose analysis prompt — for regen market intelligence.
   */
  async analyze(prompt: string, purpose = "regen_analysis"): Promise<string | null> {
    return this.relay.chatCompletion(
      [{ role: "user", content: prompt }],
      { maxTokens: 500, temperature: 0.3, purpose }
    );
  }

  /** Check if the scoring provider is available */
  get isConfigured(): boolean {
    return this.relay.isConfigured;
  }
}
