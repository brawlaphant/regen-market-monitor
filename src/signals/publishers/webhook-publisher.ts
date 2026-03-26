import crypto from "node:crypto";
import type { MarketSignal, PublishStatus, AgentId } from "../signal-schema.js";
import type { Logger } from "../../logger.js";

const RETRY_DELAY_MS = 2000;
const TIMEOUT_MS = 8000;

/**
 * Webhook publisher — fans out signals to configured HTTP endpoints.
 * Only active when WEBHOOK_URLS env var is set.
 * Supports HMAC-SHA256 signature and agent-based routing filter.
 */
export class WebhookPublisher {
  private urls: string[] = [];
  private secret: string | undefined;
  private agentFilter: AgentId[] | undefined;
  private logger: Logger;
  private deliveriesToday = 0;
  private failuresToday = 0;
  private todayStart = 0;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  init(): boolean {
    const raw = process.env.WEBHOOK_URLS;
    if (!raw) return false;

    this.urls = raw.split(",").map((u) => u.trim()).filter(Boolean);
    if (this.urls.length === 0) return false;

    this.secret = process.env.WEBHOOK_SECRET || undefined;

    const filterRaw = process.env.WEBHOOK_AGENT_FILTER;
    if (filterRaw) {
      this.agentFilter = filterRaw.split(",").map((a) => a.trim()) as AgentId[];
    }

    this.logger.info({ targets: this.urls.length, signed: !!this.secret }, "Webhook publisher configured");
    return true;
  }

  async publish(signal: MarketSignal): Promise<PublishStatus> {
    // Routing filter check
    if (this.agentFilter) {
      const overlap = signal.routing.target_agents.some((a) =>
        this.agentFilter!.includes(a)
      );
      if (!overlap) {
        return { success: true, latency_ms: 0 }; // Filtered out, not a failure
      }
    }

    const start = Date.now();
    const body = JSON.stringify(signal);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Signal-ID": signal.id,
      "X-Signal-Type": signal.signal_type,
      "X-Signal-Severity": signal.severity,
      "X-Agent-Source": "AGENT-003",
      "X-Timestamp": signal.timestamp,
    };

    if (this.secret) {
      headers["X-Signature"] = computeHmac(body, this.secret);
    }

    const results = await Promise.allSettled(
      this.urls.map((url) => this.sendWithRetry(url, body, headers))
    );

    this.trackDaily();
    const anySuccess = results.some(
      (r) => r.status === "fulfilled" && r.value
    );
    const failures = results.filter(
      (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value)
    );

    if (failures.length > 0) this.failuresToday += failures.length;

    return {
      success: anySuccess,
      latency_ms: Date.now() - start,
      error: failures.length > 0 ? `${failures.length}/${this.urls.length} targets failed` : undefined,
    };
  }

  get targetCount(): number { return this.urls.length; }
  get deliveriesTodayCount(): number { return this.deliveriesToday; }
  get failuresTodayCount(): number { return this.failuresToday; }

  private async sendWithRetry(
    url: string,
    body: string,
    headers: Record<string, string>
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) return true;
        this.logger.warn({ url, status: res.status, attempt }, "Webhook delivery failed");
      } catch (err) {
        this.logger.warn({ url, err: String(err), attempt }, "Webhook request error");
      }
      if (attempt < 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    return false;
  }

  private trackDaily(): void {
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
    if (day !== this.todayStart) {
      this.deliveriesToday = 0;
      this.failuresToday = 0;
      this.todayStart = day;
    }
    this.deliveriesToday++;
  }
}

export function computeHmac(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}
