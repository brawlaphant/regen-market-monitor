import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { cleanArtifacts } from "../../src/artifact-cleaner.js";

function mockLogger(): any {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("cleanArtifacts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "artifacts-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes old files from known subdirectories", () => {
    const dir = path.join(tmpDir, "trading-desk");
    fs.mkdirSync(dir, { recursive: true });

    // Create a file and backdate it
    const oldFile = path.join(dir, "run-old.json");
    fs.writeFileSync(oldFile, "{}");
    const oldTime = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

    const freshFile = path.join(dir, "run-fresh.json");
    fs.writeFileSync(freshFile, "{}");

    const result = cleanArtifacts(tmpDir, mockLogger(), 30);
    expect(result.removed).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  it("preserves state files", () => {
    const dir = path.join(tmpDir, "hyperliquid");
    fs.mkdirSync(dir, { recursive: true });

    // pnl-state.json should never be removed even if "old"
    // (it lives in the parent, but let's test the guard)
    const stateFile = path.join(tmpDir, "pnl-state.json");
    fs.writeFileSync(stateFile, "{}");
    const oldTime = Date.now() - 90 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stateFile, new Date(oldTime), new Date(oldTime));

    // This checks that it doesn't crash on non-matching dirs
    const result = cleanArtifacts(tmpDir, mockLogger(), 1);
    // pnl-state.json is not in a subdir, so it won't be touched
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it("skips non-existent subdirectories", () => {
    const result = cleanArtifacts(tmpDir, mockLogger(), 1);
    expect(result.removed).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("cleans across all three subdirectories", () => {
    const dirs = ["trading-desk", "litcoin", "hyperliquid"];
    const oldTime = Date.now() - 60 * 24 * 60 * 60 * 1000;

    for (const sub of dirs) {
      const dir = path.join(tmpDir, sub);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `old-artifact.json`);
      fs.writeFileSync(file, "{}");
      fs.utimesSync(file, new Date(oldTime), new Date(oldTime));
    }

    const result = cleanArtifacts(tmpDir, mockLogger(), 30);
    expect(result.removed).toBe(3);
  });

  it("ignores non-json files", () => {
    const dir = path.join(tmpDir, "litcoin");
    fs.mkdirSync(dir, { recursive: true });
    const txtFile = path.join(dir, "readme.txt");
    fs.writeFileSync(txtFile, "hello");
    const oldTime = Date.now() - 90 * 24 * 60 * 60 * 1000;
    fs.utimesSync(txtFile, new Date(oldTime), new Date(oldTime));

    const result = cleanArtifacts(tmpDir, mockLogger(), 1);
    expect(result.removed).toBe(0);
    expect(fs.existsSync(txtFile)).toBe(true);
  });

  it("never removes .tmp files", () => {
    const dir = path.join(tmpDir, "trading-desk");
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = path.join(dir, "run-123.json.tmp");
    fs.writeFileSync(tmpFile, "{}");
    const oldTime = Date.now() - 90 * 24 * 60 * 60 * 1000;
    fs.utimesSync(tmpFile, new Date(oldTime), new Date(oldTime));

    const result = cleanArtifacts(tmpDir, mockLogger(), 1);
    expect(result.removed).toBe(0);
  });
});
