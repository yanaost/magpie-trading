import { defineConfig } from "vitest/config";

/**
 * Core is the money path: the spec/ground rules require ≥90% coverage here.
 * `strategy.ts` is a type-only module (interfaces compile to nothing) so it is
 * excluded from the runtime coverage denominator.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/strategy.ts"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
