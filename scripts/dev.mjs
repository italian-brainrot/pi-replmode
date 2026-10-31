#!/usr/bin/env node
/**
 * The development loop: change a file, get the failing test back.
 *
 * Nothing here is clever: watch the source trees, work out which suite the change belongs to, run
 * that suite, print its output. `--all` runs everything once and exits, which is what CI and
 * `npm run check` use.
 *
 *   node scripts/dev.mjs              watch src/, test/ and python/ and re-run what is affected
 *   node scripts/dev.mjs --all        typecheck, lint, vitest, pytest, once
 *   node scripts/dev.mjs --ts         vitest only
 *   node scripts/dev.mjs --py         pytest only
 *   node scripts/dev.mjs --fast       skip tsc and biome while iterating
 */

import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

const watchDirs = ["src", "test", "python", "scripts"];
const watchFiles = ["requirements.txt", "tsconfig.json", "vitest.config.ts", "biome.json", "package.json", "pyproject.toml"];

function run(label, command, commandArgs, { quiet = false } = {}) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: quiet ? "pipe" : "inherit", encoding: "utf8" });
  const ms = Date.now() - started;
  if (result.error) {
    console.log(`${label}: could not run ${command}: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0 && quiet) process.stdout.write(result.stdout ?? "");
  if (result.status !== 0 && quiet) process.stderr.write(result.stderr ?? "");
  const ok = result.status === 0;
  if (quiet) console.log(`${ok ? "ok  " : "FAIL"} ${label} (${ms}ms)${ok ? "" : ` — exit ${result.status}`}`);
  return ok;
}

function typecheck() {
  return run("typecheck", "npx", ["tsc", "--noEmit"], { quiet: true });
}

function lint() {
  return run("lint", "npx", ["biome", "check", "src", "test"], { quiet: true });
}

function vitest() {
  return run("vitest", "npx", ["vitest", "--run", "--reporter=dot", ...positional]);
}

function pytest() {
  return run("pytest", "node", ["scripts/py.test.mjs", ...positional]);
}

function runAll() {
  let ok = true;
  if (!flags.has("--fast")) ok = typecheck() && ok;
  if (!flags.has("--fast")) ok = lint() && ok;
  ok = vitest() && ok;
  ok = pytest() && ok;
  return ok;
}

/** Decide what a changed path belongs to, so one keystroke does not run four suites. */
function classify(path) {
  const rel = relative(ROOT, path);
  if (rel.startsWith("python/")) {
    if (rel.endsWith("requirements.txt")) return { suite: "py", note: "requirements changed: the environment will be rebuilt" };
    return { suite: "py" };
  }
  if (rel === "requirements.txt") return { suite: "py", note: "requirements changed: the environment will be rebuilt" };
  if (rel.startsWith("src/") || rel.startsWith("test/")) return { suite: "ts" };
  if (rel.startsWith("scripts/")) return { suite: "all" };
  return { suite: "all" };
}

function onEvent(path) {
  const where = classify(path ?? "");
  if (where.note) console.log(`\n${where.note}`);
  console.log(
    `\n── ${relative(ROOT, path ?? "")} changed — ${where.suite === "py" ? "pytest" : where.suite === "ts" ? "vitest" : "everything"} ──`,
  );
  let ok = true;
  if (where.suite === "all") {
    ok = runAll();
  } else if (where.suite === "py") {
    if (!flags.has("--fast")) ok = lint();
    ok = pytest() && ok;
  } else {
    if (!flags.has("--fast")) ok = typecheck();
    ok = vitest() && ok;
  }
  console.log(ok ? "\n  ✓ green\n" : "\n  ✗ failing\n");
}

if (flags.has("--all")) {
  process.exit(runAll() ? 0 : 1);
}
if (flags.has("--ts")) {
  process.exit(vitest() ? 0 : 1);
}
if (flags.has("--py")) {
  process.exit(pytest() ? 0 : 1);
}

console.log("watching src/, test/, python/ for changes (ctrl-c to stop)");
let timer;
let pending = [];
for (const dir of watchDirs) {
  try {
    watch(resolve(ROOT, dir), { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const full = resolve(ROOT, dir, filename);
      if (!/\.(ts|tsx|mjs|js|py|toml|json|txt)$/.test(full)) return;
      pending.push(full);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = pending;
        pending = [];
        onEvent(paths[0]);
      }, 250);
    });
  } catch (error) {
    console.error(`could not watch ${dir}: ${error.message}`);
  }
}
for (const file of watchFiles) {
  try {
    watch(resolve(ROOT, file), () => {
      clearTimeout(timer);
      timer = setTimeout(() => onEvent(resolve(ROOT, file)), 250);
    });
  } catch {
    /* the file may not exist */
  }
}

process.on("SIGINT", () => {
  console.log("\nstopped");
  process.exit(0);
});
