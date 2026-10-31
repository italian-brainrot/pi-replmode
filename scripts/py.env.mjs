#!/usr/bin/env node
/**
 * Create (or report) the Python environment `run` uses: `npm run py:env`.
 *
 * This is the same code path the extension takes on the first `run` of a session, driven through
 * jiti so there is no build step. Worth running once before the test suite, which otherwise pays for
 * the build inside its first test.
 */

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { ensureEnv } = await jiti.import("../src/env.ts");

const started = Date.now();
try {
  const env = await ensureEnv((message) => console.error(`[py:env] ${message}`));
  console.log(
    JSON.stringify(
      {
        python: env.python,
        dir: env.dir,
        created: env.created,
        build_seconds: env.created ? (Date.now() - started) / 1000 : 0,
        backend: env.backend,
        interpreter: env.interpreter,
        version: env.version,
        env_dir_override: process.env.PI_REPLMODE_ENV_DIR ?? null,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`[py:env] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
