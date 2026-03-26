import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { HealthServer } from "../../src/health-server.js";
import { createMockLogger } from "../helpers/mocks.js";

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: data }));
    }).on("error", reject);
  });
}

describe("HealthServer", () => {
  let server: HealthServer;
  // Use a random high port to avoid conflicts
  const port = 30000 + Math.floor(Math.random() * 10000);

  afterEach(async () => {
    if (server) await server.close();
  });

  it("GET /health returns status starting before first poll", async () => {
    server = new HealthServer(port, createMockLogger());
    await new Promise((r) => setTimeout(r, 50)); // wait for listen
    const res = await httpGet(port, "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("starting");
    expect(body.lastPollAt).toBeNull();
  });

  it("GET /health returns ok after poll", async () => {
    server = new HealthServer(port, createMockLogger());
    server.lastPollAt = new Date();
    server.mcpReachable = true;
    server.alertsFiredToday = 3;
    await new Promise((r) => setTimeout(r, 50));

    const res = await httpGet(port, "/health");
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.alertsFiredToday).toBe(3);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("GET /health returns degraded when MCP unreachable", async () => {
    server = new HealthServer(port, createMockLogger());
    server.lastPollAt = new Date();
    server.mcpReachable = false;
    await new Promise((r) => setTimeout(r, 50));

    const res = await httpGet(port, "/health");
    const body = JSON.parse(res.body);
    expect(body.status).toBe("degraded");
  });

  it("GET /state returns 503 before first poll", async () => {
    server = new HealthServer(port, createMockLogger());
    await new Promise((r) => setTimeout(r, 50));
    const res = await httpGet(port, "/state");
    expect(res.status).toBe(503);
  });

  it("GET /state returns snapshot after poll", async () => {
    server = new HealthServer(port, createMockLogger());
    server.snapshot = { lastPollAt: "2024-01-01", pollDurationMs: 500 } as any;
    await new Promise((r) => setTimeout(r, 50));

    const res = await httpGet(port, "/state");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.lastPollAt).toBe("2024-01-01");
  });

  it("GET /tuning-report returns 503 when tuner not set", async () => {
    server = new HealthServer(port, createMockLogger());
    await new Promise((r) => setTimeout(r, 50));
    const res = await httpGet(port, "/tuning-report");
    expect(res.status).toBe(503);
  });

  it("GET /tuning-report returns report when tuner is set", async () => {
    server = new HealthServer(port, createMockLogger());
    server.tuningAnalyzer = () => ({ ready: false, reason: "no_data" });
    await new Promise((r) => setTimeout(r, 50));

    const res = await httpGet(port, "/tuning-report");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ready).toBe(false);
  });

  it("GET /unknown returns 404", async () => {
    server = new HealthServer(port, createMockLogger());
    await new Promise((r) => setTimeout(r, 50));
    const res = await httpGet(port, "/unknown");
    expect(res.status).toBe(404);
  });
});
