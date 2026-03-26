import { describe, it, expect } from "vitest";
import { createLogger } from "../../src/logger.js";

describe("createLogger", () => {
  it("creates a logger with default level", () => {
    const logger = createLogger();
    expect(logger.level).toBe("info");
  });

  it("creates a logger with custom level", () => {
    const logger = createLogger("debug");
    expect(logger.level).toBe("debug");
  });

  it("logger has required methods", () => {
    const logger = createLogger("error");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });
});
