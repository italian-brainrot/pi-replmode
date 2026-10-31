/**
 * Where pi-replmode keeps its files.
 *
 * Nothing goes in the repository: daemons run with the *repo* only on their import path (they read
 * it), and everything they write lives under `<agent-dir>/replmode/`, the same place pi-bg-tasks
 * puts its logs. That keeps the project folder clean, makes the state easy to delete, and gives the
 * tests one directory to point at a temp agent dir.
 */

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** This package's source root: the daemon is shipped as Python source next to the extension. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Put on the daemon's PYTHONPATH. */
export const PYTHON_PACKAGE_DIR = join(PACKAGE_ROOT, "python");

/** The dependency pin that names the Python environment. */
export const REQUIREMENTS_FILE = join(PACKAGE_ROOT, "requirements.txt");

function isSourceCheckout(root: string): boolean {
  return existsSync(join(root, "package.json")) && existsSync(join(root, "python", "replmode", "daemon.py"));
}

if (!isSourceCheckout(PACKAGE_ROOT)) {
  // A daemon that cannot find its own source fails at spawn time with a confusing protocol EOF, so
  // say what is actually wrong now instead.
  console.error(
    `pi-replmode: the Python daemon is missing next to the extension (looked in ${PYTHON_PACKAGE_DIR}). ` +
      "If this package was installed from a tarball, check that `files` includes `python`.",
  );
}

const BASE = join(getAgentDir(), "replmode");

/** One log per exec: the full capture, kept when it was truncated or moved to the background. */
export const EXEC_LOG_DIR = join(BASE, "exec");
/** The daemon's own diagnostics, per channel. Never on the protocol or capture streams. */
export const DAEMON_LOG_DIR = join(BASE, "daemon");
/** What each channel ran, so a fresh session can see what a lost channel held. */
export const HISTORY_DIR = join(BASE, "history");
/** IPython's own profile (sqlite history) per channel, instead of ~/.ipython. */
export const IPYTHON_DIR = join(BASE, "ipython");

export function ensureDirs(): void {
  for (const dir of [EXEC_LOG_DIR, DAEMON_LOG_DIR, HISTORY_DIR, IPYTHON_DIR]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // A read-only agent dir surfaces when a log is actually written.
    }
  }
}

/** Best-effort identity for a directory, used to notice a stale env directory. */
export function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
