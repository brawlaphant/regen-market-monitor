import type { Logger } from "../../logger.js";

export interface GovernanceEvent {
  proposal_id: string;
  title: string;
  status: string;
  voting_end_time: string;
  yes_pct: number;
  no_pct: number;
  abstain_pct: number;
  description_excerpt: string;
  importance: "HIGH" | "MEDIUM" | "LOW";
}

export class GovernanceSource {
  private lcdUrl: string;
  private logger: Logger;
  private cache: GovernanceEvent[] = [];

  constructor(logger: Logger) {
    this.lcdUrl = (process.env.REGEN_LCD_URL || "https://regen.api.boz.moe").replace(/\/$/, "");
    this.logger = logger;
  }

  async poll(): Promise<GovernanceEvent[]> {
    const events: GovernanceEvent[] = [];
    try {
      // Active proposals
      const votingRes = await fetch(`${this.lcdUrl}/cosmos/gov/v1/proposals?proposal_status=PROPOSAL_STATUS_VOTING_PERIOD`, { signal: AbortSignal.timeout(12000) });
      if (votingRes.ok) {
        const data = (await votingRes.json()) as any;
        for (const p of data?.proposals || []) {
          events.push(this.parseProposal(p, "HIGH"));
        }
      }
      // Recent passed
      const passedRes = await fetch(`${this.lcdUrl}/cosmos/gov/v1/proposals?proposal_status=PROPOSAL_STATUS_PASSED&pagination.limit=10&pagination.reverse=true`, { signal: AbortSignal.timeout(12000) });
      if (passedRes.ok) {
        const data = (await passedRes.json()) as any;
        for (const p of (data?.proposals || []).slice(0, 10)) {
          const title = (p.title || p.messages?.[0]?.content?.title || "").toLowerCase();
          const importance = title.includes("marketplace") || title.includes("token") ? "HIGH" : "MEDIUM";
          events.push(this.parseProposal(p, importance));
        }
      }
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Governance poll failed");
    }
    this.cache = events;
    return events;
  }

  getCached(): GovernanceEvent[] { return this.cache; }

  private parseProposal(p: any, importance: "HIGH" | "MEDIUM" | "LOW"): GovernanceEvent {
    const tally = p.final_tally_result || {};
    const yes = parseFloat(tally.yes_count || tally.yes || "0");
    const no = parseFloat(tally.no_count || tally.no || "0");
    const abstain = parseFloat(tally.abstain_count || tally.abstain || "0");
    const total = yes + no + abstain || 1;
    return {
      proposal_id: p.id || p.proposal_id || "",
      title: p.title || p.messages?.[0]?.content?.title || "Untitled",
      status: p.status || "",
      voting_end_time: p.voting_end_time || "",
      yes_pct: Math.round((yes / total) * 100),
      no_pct: Math.round((no / total) * 100),
      abstain_pct: Math.round((abstain / total) * 100),
      description_excerpt: (p.summary || p.messages?.[0]?.content?.description || "").slice(0, 300),
      importance,
    };
  }
}
