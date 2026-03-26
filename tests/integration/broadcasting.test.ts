import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { SignalStore } from "../../src/signals/signal-store.js";
import { SignalPublisher } from "../../src/signals/signal-publisher.js";
import { buildSignal } from "../../src/signals/signal-factory.js";
import { HealthServer } from "../../src/health-server.js";
import type { MarketSignal, LowSupplyData } from "../../src/signals/signal-schema.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeSignal(): MarketSignal {
  const data: LowSupplyData = { available_credits: 100, threshold: 1000, deficit: 900 };
  return buildSignal("LOW_SUPPLY", data, { workflow_id: "WF-MM-02" });
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: data }));
    }).on("error", reject);
  });
}

describe("Integration: Broadcasting Pipeline", () => {
  let tmpDir: string;
  let store: SignalStore;
  let publisher: SignalPublisher;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "bcast-"));
    store = new SignalStore(tmpDir, mockLogger(), 100);
    publisher = new SignalPublisher(store, mockLogger());
    // Init without Redis or webhooks — REST only
    await publisher.init();
  });

  afterEach(async () => {
    await publisher.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("publish stores signal and returns stored=true", async () => {
    const signal = makeSignal();
    const result = await publisher.publish(signal);
    expect(result.stored).toBe(true);
    expect(result.signal_id).toBe(signal.id);
    expect(store.getById(signal.id)).toBeDefined();
  });

  it("publish with Redis unavailable still stores and returns", async () => {
    const signal = makeSignal();
    const result = await publisher.publish(signal);
    expect(result.stored).toBe(true);
    expect(result.redis.success).toBe(false);
    expect(result.redis.error).toBe("not_configured");
  });

  it("invalid signal is rejected, not stored", async () => {
    const bad = { id: "bad" } as any;
    const result = await publisher.publish(bad);
    expect(result.stored).toBe(false);
  });

  it("stats reflect published signals", async () => {
    await publisher.publish(makeSignal());
    await publisher.publish(makeSignal());
    const stats = publisher.stats;
    expect(stats.signals_published_today).toBe(2);
  });
});

describe("Integration: /signals REST endpoint", () => {
  let tmpDir: string;
  let store: SignalStore;
  let publisher: SignalPublisher;
  let health: HealthServer;
  const port = 31000 + Math.floor(Math.random() * 10000);

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "rest-"));
    store = new SignalStore(tmpDir, mockLogger(), 100);
    publisher = new SignalPublisher(store, mockLogger());
    await publisher.init();

    health = new HealthServer(port, mockLogger());
    health.signalStore = store;
    health.signalPublisher = publisher;
    await new Promise((r) => setTimeout(r, 50));
  });

  afterEach(async () => {
    await publisher.close();
    await health.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /signals returns empty list when no signals", async () => {
    const res = await httpGet(port, "/signals");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.signals).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("GET /signals returns stored signals", async () => {
    await publisher.publish(makeSignal());
    await publisher.publish(makeSignal());
    const res = await httpGet(port, "/signals?limit=10");
    const body = JSON.parse(res.body);
    expect(body.count).toBe(2);
    expect(body.signals).toHaveLength(2);
  });

  it("GET /signals filters by type", async () => {
    await publisher.publish(makeSignal());
    const res = await httpGet(port, "/signals?type=PRICE_ANOMALY");
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0); // We only published LOW_SUPPLY
  });

  it("GET /signals/:id returns 404 for unknown", async () => {
    const res = await httpGet(port, "/signals/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("GET /signals/:id returns stored signal", async () => {
    const signal = makeSignal();
    await publisher.publish(signal);
    const res = await httpGet(port, `/signals/${signal.id}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(signal.id);
  });

  it("GET /signals/schema returns JSON schema", async () => {
    const res = await httpGet(port, "/signals/schema");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toBe("MarketSignal");
  });

  it("GET /signals/stats returns counts", async () => {
    await publisher.publish(makeSignal());
    const res = await httpGet(port, "/signals/stats");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    expect(body.publishers_active).toContain("rest");
  });
});
