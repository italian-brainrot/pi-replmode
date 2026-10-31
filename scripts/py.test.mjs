#!/usr/bin/env node
/**
 * Run the daemon's Python tests against the same environment `run` uses: `npm run py:test`.
 *
 * Extra arguments go to pytest, so `npm run py:test -- -k interrupt` runs one group.
 */

import { spawnSync } from "node:child_process";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { ensureEnv } = await jiti.import("../src/env.ts");

let env;
try {
  env = await ensureEnv((message) => console.error(`[py:test] ${message}`));
} catch (error) {
  console.error(`[py:test] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const args = ["-m", "pytest", "-q", ...process.argv.slice(2)];
const result = spawnSync(env.python, args, { cwd: process.cwd(), stdio: "inherit" });
if (result.error) {
  console.error(`[py:test] could not run pytest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
