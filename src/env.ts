/**
 * The Python environment `run` executes in.
 *
 * Auto-created, disposable, and never inside the project folder: the venv lives at
 * `${XDG_CACHE_HOME:-~/.cache}/pi-replmode/py-env-<hash>`, where `<hash>` covers the interpreter and
 * the pinned requirements, so a changed pin or a new Python gets a fresh environment instead of a
 * half-upgraded one, and wiping the cache costs a re-sync and nothing else. `PI_REPLMODE_ENV_DIR`
 * points the environment somewhere else; `PI_REPLMODE_REQUIREMENTS` names a different pin file, which
 * by the same rule gets its own environment.
 *
 * Nothing is ever installed into the repository, the project folder, or the user's system Python.
 * With no `uv` and no usable `python -m venv`, the tool fails with the exact command to fix it
 * rather than quietly installing into the interpreter it found.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { requirementsFile } from "./paths.ts";

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const MARKER = ".complete";
/** Two pi processes starting at once must not build the same env twice. */
const LOCK_STALE_MS = 20 * 60 * 1000;

export interface PythonEnv {
  /** The interpreter to run the daemon with. */
  python: string;
  dir: string;
  /** Environment built during this call (the first `run` pays for it). */
  created: boolean;
  seconds: number;
  backend: "uv" | "venv+pip";
  interpreter: string;
  version: string;
}

let inflight: Promise<PythonEnv> | undefined;

/** Single-flight: concurrent `run` calls on different channels share one build. */
export function ensureEnv(onProgress: (message: string) => void = () => {}): Promise<PythonEnv> {
  inflight ??= buildEnv(onProgress).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function buildEnv(onProgress: (message: string) => void): Promise<PythonEnv> {
  const started = Date.now();
  const base = await baseInterpreter();
  const version = await interpreterVersion(base);
  const requirementsPath = requirementsFile();
  let requirements: string;
  try {
    requirements = readFileSync(requirementsPath, "utf8");
  } catch {
    throw new Error(
      `cannot read the requirements file ${requirementsPath}${process.env.PI_REPLMODE_REQUIREMENTS ? " (PI_REPLMODE_REQUIREMENTS)" : ""}. ` +
        "Restore it, or point PI_REPLMODE_REQUIREMENTS at one that exists.",
    );
  }
  const dir = process.env.PI_REPLMODE_ENV_DIR?.trim() || envDirFor(base, version, requirements);
  const hash = hashOf(base, version, requirements);
  const python = join(dir, "bin", "python");
  const marker = join(dir, MARKER);

  if (existsSync(marker) && existsSync(python)) {
    return { python, dir, created: false, seconds: 0, backend: "uv", interpreter: base, version };
  }

  const uv = await findUv();
  const backend: PythonEnv["backend"] = uv ? "uv" : "venv+pip";
  if (!uv && !(await venvWorks(base))) {
    throw new Error(
      `cannot create the pi-replmode Python environment: no uv found and \`${base} -m venv\` does not work.\n` +
        `Fix it with one of:\n  uv venv ${dir} --python ${base} && uv pip install --python ${python} -r ${requirementsPath}\n` +
        `  ${base} -m venv ${dir} && ${python} -m pip install -r ${requirementsPath}\n` +
        "or point PI_REPLMODE_PYTHON at an interpreter that already has ipython installed.",
    );
  }

  const release = await acquireLock(`${dir}.lock`);
  try {
    // Another pi process may have finished the same build while we waited for the lock.
    if (existsSync(marker) && existsSync(python)) {
      return { python, dir, created: false, seconds: 0, backend, interpreter: base, version };
    }

    onProgress(`creating the pi-replmode Python environment in ${dir} (${backend})`);
    if (uv) {
      await run(uv, ["venv", dir, "--python", base], `uv venv failed for ${dir}`);
      await run(uv, ["pip", "install", "--python", python, "-r", requirementsPath], `uv pip install -r ${requirementsPath} failed`);
    } else {
      await run(base, ["-m", "venv", dir], `${base} -m venv ${dir} failed`);
      await run(python, ["-m", "pip", "install", "-r", requirementsPath], `${python} -m pip install -r ${requirementsPath} failed`);
    }

    // A marker with the pin it was built from, so a hand-edited env is detectable.
    writeFileSync(marker, JSON.stringify({ hash, base, version, backend, builtAt: new Date().toISOString() }));
    const seconds = (Date.now() - started) / 1000;
    onProgress(`environment ready (${seconds.toFixed(1)}s)`);
    return { python, dir, created: true, seconds, backend, interpreter: base, version };
  } finally {
    release();
  }
}

function cacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  return join(xdg || join(homedir(), ".cache"), "pi-replmode");
}

/**
 * The environment directory for an interpreter and a pin set.
 *
 * Naming the directory after both is the whole upgrade story: changed pins or a new interpreter mean
 * a fresh environment rather than a half-upgraded one, and a wiped cache costs a re-sync and nothing
 * else. Exported so a test can assert that property without editing the repo's pin file.
 */
export function envDirFor(interpreter: string, version: string, requirements: string): string {
  return join(cacheRoot(), `py-env-${hashOf(interpreter, version, requirements)}`);
}

function hashOf(interpreter: string, version: string, requirements: string): string {
  return createHash("sha256").update(`${interpreter}\n${version}\n${requirements}`).digest("hex").slice(0, 12);
}

/** `python3` on PATH unless PI_REPLMODE_PYTHON names one. */
async function baseInterpreter(): Promise<string> {
  const configured = process.env.PI_REPLMODE_PYTHON?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error(`PI_REPLMODE_PYTHON points at a missing interpreter: ${configured}`);
    return configured;
  }
  for (const candidate of ["python3", "python"]) {
    const found = await which(candidate);
    if (found) return found;
  }
  throw new Error("no python3 on PATH; set PI_REPLMODE_PYTHON to an interpreter to build the environment from");
}

async function interpreterVersion(interpreter: string): Promise<string> {
  const out = await run(interpreter, ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], `cannot run ${interpreter}`);
  return out.trim() || "unknown";
}

async function findUv(): Promise<string | undefined> {
  const configured = process.env.PI_REPLMODE_UV?.trim();
  if (configured) return existsSync(configured) ? configured : undefined;
  return (await which("uv")) ?? (existsSync(join(homedir(), ".local", "bin", "uv")) ? join(homedir(), ".local", "bin", "uv") : undefined);
}

async function venvWorks(interpreter: string): Promise<boolean> {
  try {
    await run(interpreter, ["-c", "import venv, ensurepip"], "venv unavailable");
    return true;
  } catch {
    return false;
  }
}

async function which(binary: string): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, binary);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // Not there.
    }
  }
  return undefined;
}

/** `mkdir` as a lock: it is atomic, needs no helper process, and cannot be left held by a crash. */
async function acquireLock(lockPath: string): Promise<() => void> {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  // The plain mkdir below *is* the lock, so it has to stay non-recursive: `recursive: true` swallows
  // EEXIST, which is the one thing the lock depends on. Only its parent is created recursively.
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockPath);
      return () => {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`timed out waiting for another process to finish building the environment (${lockPath})`);
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Racing with the holder; just wait.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** Run a command, capturing output; failure becomes an error carrying the tool's own message. */
function run(command: string, args: string[], whatFailed: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${whatFailed}: timed out after ${BUILD_TIMEOUT_MS / 1000}s`));
    }, BUILD_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${whatFailed}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n").slice(-4000);
      reject(new Error(`${whatFailed} (exit ${code ?? "signal"}):\n${detail || "(no output)"}`));
    });
  });
}
