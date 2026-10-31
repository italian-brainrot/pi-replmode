/**
 * Turning a channel name into file names without collisions.
 *
 * A channel name comes from the model, and one name is used as three file names: the daemon's log,
 * the history file, and the IPython profile directory. They all have to come from *this* function, so
 * the three always describe the same channel. Sanitising alone is not enough — `a/b` and `a_b` collapse
 * onto one file, which means two live daemons writing one log, one history file shared by two
 * channels, and two `history.sqlite` writers in one profile directory (R2-04).
 *
 * The rule: a name that is already a safe file name keeps it exactly, so `main`'s files stay readable
 * and stable across versions; anything else gets a short digest of the real name appended. The digest
 * is what makes the mapping one-to-one in practice — it is derived from the whole name, so no two names
 * that differ share a stem.
 */

import { createHash } from "node:crypto";

/** Characters that are safe in a file name on every platform we run on. */
const UNSAFE = /[^a-zA-Z0-9_-]/g;
/** How much of the readable part survives before the digest. */
const STEM_MAX = 40;
/** Hex characters of the digest: 40 bits, and channel names are few and human-chosen. */
const DIGEST_CHARS = 10;

export function channelFileStem(name: string): string {
  const readable = name.replace(UNSAFE, "_").slice(0, STEM_MAX);
  if (!readable) return `channel-${digest(name)}`;
  // `readable === name` also implies the name is not longer than the cap, so an already-usable name is
  // used verbatim and its files keep the obvious name.
  if (readable === name) return readable;
  return `${readable}-${digest(name)}`;
}

function digest(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, DIGEST_CHARS);
}
