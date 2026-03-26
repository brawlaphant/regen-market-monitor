import fs from "node:fs";
import path from "node:path";
import type { AuditEntry, AuditEvent } from "../types.js";
import type { Logger } from "../logger.js";

/**
 * Append-only audit log for the proposal lifecycle.
 * Writes one JSON object per line to data/audit-log.jsonl.
 * NEVER deletes or modifies existing entries.
 */
export class AuditLog {
  private filePath: string;
  private logger: Logger;

  constructor(dataDir: string, logger: Logger) {
    this.filePath = path.join(dataDir, "audit-log.jsonl");
    this.logger = logger;

    // Ensure data directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  append(
    event: AuditEvent,
    proposalId: string,
    actorType: "agent" | "human",
    data: Record<string, unknown>
  ): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      event,
      proposalId,
      actorType,
      data: this.sanitize(data),
      version: "1.0",
    };

    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
      this.logger.debug({ event, proposalId }, "Audit log entry written");
    } catch (err) {
      this.logger.error({ err, event, proposalId }, "Failed to write audit log");
    }
  }

  /** Read all entries (for debugging / health checks) */
  readAll(): AuditEntry[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const content = fs.readFileSync(this.filePath, "utf-8");
      return content
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch {
      return [];
    }
  }

  /** Strip any accidental mnemonic leaks from data */
  private sanitize(data: Record<string, unknown>): Record<string, unknown> {
    const clean = { ...data };
    for (const key of Object.keys(clean)) {
      const val = clean[key];
      if (typeof val === "string" && val.split(" ").length >= 12) {
        clean[key] = "[REDACTED_POSSIBLE_MNEMONIC]";
      }
    }
    return clean;
  }
}
