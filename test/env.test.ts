/**
 * The Python environment: created where a wiped cache costs nothing, never in the project folder,
 * never in the user's system Python.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureEnv } from "../src/env.ts";
import { makeTempDir, repoRoot } from "./helpers/extension.ts";

describe("ensureEnv", () => {
  it("builds the environment outside the repository and reuses it on the next call", async () => {
    const temp = makeTempDir("replmode-pyenv-");
    const dir = join(temp.path, "env");
    process.env.PI_REPLMODE_ENV_DIR = dir;
    try {
      const started = Date.now();
      const first = await ensureEnv();
      expect(first.created).toBe(true);
      expect(first.dir).toBe(dir);
      expect(first.dir.startsWith(repoRoot)).toBe(false);
      expect(first.backend).toBe("uv");
      expect(first.seconds ?? (Date.now() - started) / 1000).toBeGreaterThan(0);

      const second = await ensureEnv();
      expect(second.created).toBe(false);
      expect(second.python).toBe(first.python);

      const marker = JSON.parse(readFileSync(join(dir, ".complete"), "utf8"));
      expect(marker.hash).toMatch(/^[0-9a-f]{12}$/);

      // The pinned set is really there, and the daemon's own imports work.
      const check = spawnSync(
        first.python,
        ["-c", "import IPython, numpy, pandas, polars, scipy, sklearn, cv2, PIL, yaml, httpx, matplotlib; print(IPython.__version__)"],
        {
          encoding: "utf8",
        },
      );
      expect(check.status, check.stderr).toBe(0);
      expect(check.stdout.trim()).toMatch(/^9\./);
    } finally {
      delete process.env.PI_REPLMODE_ENV_DIR;
      temp.dispose();
    }
  }, 600_000);

  it("builds once when two channels ask for the environment at the same time", async () => {
    // Two channels starting at once must not start two `uv` runs against the same directory. The
    // mkdir lock covers two pi processes; this covers one process asking twice concurrently.
    const temp = makeTempDir("replmode-pyenv-");
    const dir = join(temp.path, "env");
    process.env.PI_REPLMODE_ENV_DIR = dir;
    try {
      const seen: string[] = [];
      const [first, second] = await Promise.all([ensureEnv((m) => seen.push(`a:${m}`)), ensureEnv((m) => seen.push(`b:${m}`))]);
      expect(first.python).toBe(second.python);
      expect(first.created).toBe(second.created);
      expect(first.seconds).toBe(second.seconds);
      expect(seen.filter((line) => line.startsWith("a:"))).toHaveLength(seen.length);
      expect(seen.filter((line) => line.startsWith("b:"))).toHaveLength(0);
      expect(existsSync(join(dir, ".complete"))).toBe(true);
    } finally {
      delete process.env.PI_REPLMODE_ENV_DIR;
      temp.dispose();
    }
  }, 600_000);

  it("names the environment it would use, after the interpreter and the pins", async () => {
    const withOverride = process.env.PI_REPLMODE_ENV_DIR;
    try {
      delete process.env.PI_REPLMODE_ENV_DIR;
      const first = await ensureEnv();
      const cacheRoot = join(process.env.XDG_CACHE_HOME || join(process.env.HOME ?? "", ".cache"), "pi-replmode");
      expect(first.dir.startsWith(cacheRoot)).toBe(true);
      expect(first.dir).toMatch(/py-env-[0-9a-f]{12}$/);
    } finally {
      if (withOverride !== undefined) process.env.PI_REPLMODE_ENV_DIR = withOverride;
    }
  });

  it("fails loudly when PI_REPLMODE_PYTHON points at nothing", async () => {
    const saved = process.env.PI_REPLMODE_PYTHON;
    process.env.PI_REPLMODE_PYTHON = "/nonexistent/python";
    try {
      await expect(ensureEnv()).rejects.toThrow(/PI_REPLMODE_PYTHON/);
    } finally {
      if (saved === undefined) delete process.env.PI_REPLMODE_PYTHON;
      else process.env.PI_REPLMODE_PYTHON = saved;
    }
  });

  it("installs nothing into the repository", async () => {
    for (const name of ["venv", ".venv", "site-packages"]) {
      expect(existsSync(join(repoRoot, name)), name).toBe(false);
    }
  });
});
