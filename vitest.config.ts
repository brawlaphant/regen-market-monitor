import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "node_modules"],
      reporter: ["text", "json", "html"],
      thresholds: {
        lines: 75,
        functions: 80,
        branches: 70,
      },
    },
  },
});
