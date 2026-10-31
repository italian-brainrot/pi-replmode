/**
 * Turning a channel name into file names without collisions.
 *
 * A channel name comes from the model, and one name is used as three file names: the daemon's log,
 * the history file, and the IPython profile directory. They all have to come from *this* function, so
 * the three always describe the same channel. Sanitising alone is not enough — `a/b` and `a_b` collapse
 * onto one file, which means two live daemons writing one log, one history file shared by two
 * channels, and two `history.sqlite` writers in one profile directory (R2-04).
 *
 * The rule, and why it is one-to-one:
 *
 * - a name that is already a safe file name *and* does not look like a digested name keeps it exactly,
 *   so `main`'s files stay readable and stable across versions;
 * - anything else gets `-<digest>` appended, a digest of the whole name, so two names that sanitise the
 *   same way differ by 40 bits of hash;
 * - a name that already *looks* digested (`foo-<10 hex>`) also gets the digest appended, even though it
 *   is already usable. `-\w` is a legal part of a name, so the stem this function produces for one
 *   channel is itself a name a model can type, and without this third rule the mapping has fixed
 *   points: `r3-dig/x` and `r3-dig_x-f395bbcba5` would share a daemon log, a history file and an
 *   IPython profile (R3-03). A name that looks digested is therefore never used verbatim, which is what
 *   makes the whole mapping injective rather than merely unlikely to collide.
 *
 * Note what this does *not* mean: the function is not idempotent, and nothing may feed a stem back into
 * it. Every call takes the channel's real name.
 */

import { createHash } from "node:crypto";

/** Characters that are safe in a file name on every platform we run on. */
const UNSAFE = /[^a-zA-Z0-9_-]/g;
/** How much of the readable part survives before the digest. */
const STEM_MAX = 40;
/** Hex characters of the digest: 40 bits, and channel names are few and human-chosen. */
const DIGEST_CHARS = 10;
/** What this function appends. A name matching this is one this function produced, not one it can trust. */
const LOOKS_DIGESTED = new RegExp(`-[0-9a-f]{${DIGEST_CHARS}}$`);

export function channelFileStem(name: string): string {
  const readable = name.replace(UNSAFE, "_").slice(0, STEM_MAX);
  if (!readable) return `channel-${digest(name)}`;
  // `readable === name` also implies the name is not longer than the cap, so an already-usable name is
  // used verbatim and its files keep the obvious name — unless it looks like a digest this function
  // appended for some other name, which is the fixed point R3-03 found.
  if (readable === name && !LOOKS_DIGESTED.test(name)) return readable;
  return `${readable}-${digest(name)}`;
}

function digest(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, DIGEST_CHARS);
}
