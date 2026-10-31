import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// These tests spawn real Python daemons (and a real venv), so they are heavier than typical unit
// tests and must not share module state: each file gets a fresh registry and its own temp agent dir.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    isolate: true,
    pool: "forks",
    maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),
    testTimeout: 60_000,
    hookTimeout: 120_000,
    teardownTimeout: 15_000,
  },
});
