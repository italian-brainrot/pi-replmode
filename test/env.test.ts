/**
 * The Python environment: created where a wiped cache costs nothing, never in the project folder,
 * never in the user's system Python.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureEnv, envDirFor } from "../src/env.ts";
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

  it("R1-12: gives a different pin file its own environment directory", async () => {
    // The property the whole upgrade story leans on: changed pins mean a fresh environment, not a
    // half-upgraded one. The repo's own pin file is a constant, so the test brings two others.
    const temp = makeTempDir("replmode-pins-");
    const cache = join(temp.path, "cache");
    const pinsA = join(temp.path, "a.txt");
    const pinsB = join(temp.path, "b.txt");
    writeFileSync(pinsA, "pi-replmode-does-not-exist-000 == 1.0.0\n", "utf8");
    writeFileSync(pinsB, "pi-replmode-does-not-exist-000 == 2.0.0\n", "utf8");

    const saved = {
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      PI_REPLMODE_REQUIREMENTS: process.env.PI_REPLMODE_REQUIREMENTS,
      PI_REPLMODE_ENV_DIR: process.env.PI_REPLMODE_ENV_DIR,
    };
    const progress: string[] = [];
    try {
      process.env.XDG_CACHE_HOME = cache;
      delete process.env.PI_REPLMODE_ENV_DIR;

      // Two pin files, two directories. The installs themselves are expected to fail.
      for (const pins of [pinsA, pinsB]) {
        process.env.PI_REPLMODE_REQUIREMENTS = pins;
        await ensureEnv((message) => progress.push(message)).catch(() => undefined);
      }

      const dirs = progress
        .map((message) => /environment in (\S+) \(/.exec(message)?.[1])
        .filter((dir): dir is string => dir !== undefined);
      expect(dirs).toHaveLength(2);
      expect(dirs[0]).toMatch(/py-env-[0-9a-f]{12}$/);
      expect(dirs[0]).toContain(cache);
      expect(dirs[0]).not.toBe(dirs[1]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      temp.dispose();
    }
  }, 300_000);

  it("names the environment after the interpreter and the pins, not after the folder", () => {
    const same = envDirFor("/usr/bin/python3", "3.14.0", "ipython==9.18.0\n");
    expect(same).toMatch(/py-env-[0-9a-f]{12}$/);
    expect(envDirFor("/usr/bin/python3", "3.14.0", "ipython==9.17.0\n"), "a changed pin must mean a new directory").not.toBe(same);
    expect(envDirFor("/usr/bin/python3", "3.15.0", "ipython==9.18.0\n"), "a new interpreter must mean a new directory").not.toBe(same);
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
