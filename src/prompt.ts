/**
 * The model-facing prompt surface.
 *
 * Everything said to the model through the prompt goes into one of pi's own slots. What the tools are
 * and how they behave lives in their descriptions and in the `promptGuidelines` registered with each of
 * them (see `index.ts`); this file renders the one thing a tool description cannot carry — which
 * channels an earlier pi process left behind, knowable only at a session boundary — as guideline bullets
 * that `index.ts` appends to `options.promptGuidelines`.
 *
 * There is deliberately no custom `options.sections[...]` entry. pi builds `preamble`, `tools` and
 * `rules` itself and leaves all three out when the user overrides the prompt (`SYSTEM.md` in the agent
 * dir or in the project, or `--system-prompt`); a section of our own would survive that and keep
 * speaking into a prompt whose owner asked for their own words. pi leaves the guidelines out the same
 * way, so the contribution here disappears exactly when the prompt does.
 *
 * The bullets are computed once per session: pi diffs the prompt against the system message it is
 * replaying, so rules that change mid-session are written into the transcript again and break the
 * provider's prompt cache from there down. Only a session boundary (`session_start`) re-reads history.
 */

import { formatDuration, oneLine } from "./format.ts";
import type { HistoryNote } from "./manager.ts";

/** How much of a remembered name the note quotes (R3-01). */
const DEFINITION_HINT_NAME_CHARS = 60;
/**
 * How much of a record's own fields the note quotes, bounded on the **read** path (R4-01). The write
 * path has clipped these since pass 3, but a history file may have been written by a build that did
 * not — or by something that is not this program at all, which is exactly what F3-04 assumed about the
 * remembered definitions and why it clips them here too.
 */
const HISTORY_CHANNEL_NAME_CHARS = 200;
const HISTORY_CODE_HINT_CHARS = 400;
const HISTORY_STATUS_HINT_CHARS = 40;
/**
 * Characters that would reshape the note rather than be quoted by it: any control character, and the
 * Unicode line separators that are not control characters. A channel name may legally contain them —
 * `run` only refuses a name that is too long — and each note is one guideline bullet, so a name
 * holding one can add a bullet of its own choosing to the system prompt of every later session. Marks
 * and joiners that cannot break a line (bidi controls, zero-width joiners) are still quoted as they came.
 */
const UNQUOTABLE = /[\p{Cc}\u2028\u2029]/u;
/** What the note says instead of quoting a name it cannot put on a line. */
const UNQUOTABLE_NAME = "(a channel whose name this note cannot print)";

/**
 * The session's contribution to pi's guidelines list: the channels an earlier process had, which are
 * gone here. Empty when there is nothing to say, which is the common case.
 *
 * One bullet per remembered channel, so a record can add one bullet and nothing else, and the lead-in
 * and the closing bullet say what the list means.
 */
export function lostChannelGuidelines(notes: HistoryNote[]): string[] {
  if (notes.length === 0) return [];
  return [
    "pi-replmode: these channels ran in an earlier pi process and are gone now, along with their variables:",
    ...notes.map((note) => lostChannelLine(note)),
    "pi-replmode: nothing from that listing is bound; re-create what you need instead of assuming it is there.",
  ];
}

/**
 * One remembered channel, as one guideline bullet.
 *
 * The line is built inside a `try` because the record it reads came from a file this build did not
 * necessarily write: a `TypeError` from here escapes `before_agent_start`, pi reports handler errors
 * without ending the run, and what the model gets is no listing for that turn at all — while pi still
 * replays whatever `rules` the transcript already carries, which can name channels that are live again
 * and omit the ones that went since. One unreadable record costs its own bullet and nothing else (R5-03).
 */
function lostChannelLine(note: HistoryNote): string {
  const label = historyChannelLabel(note);
  try {
    return `channel "${label}": last cell ${quoted(note.status, HISTORY_STATUS_HINT_CHARS)} in ${formatDuration(note.elapsed)} \u2014 ${quoted(note.code, HISTORY_CODE_HINT_CHARS)}${definitionHint(note)}${tornHint(note)}`;
  } catch {
    return `channel "${label}": (a record this note could not read)`;
  }
}

/**
 * The name the note and the restart notification quote for a remembered channel (R4-01).
 *
 * Two bounds, because the record is not trusted: the name is shortened to what a note can carry, and a
 * name that is not a single printable line is not quoted at all — flattening it would keep every word of
 * it, and the words are the injection. The record's raw name stays the key everywhere else: the
 * liveness check that decides whether this channel is gone at all has to match what `run` was given.
 */
export function historyChannelLabel(note: HistoryNote): string {
  const name = typeof note.channel === "string" ? note.channel : "";
  if (UNQUOTABLE.test(name)) return UNQUOTABLE_NAME;
  return oneLine(name, HISTORY_CHANNEL_NAME_CHARS);
}

/** One field of a history record, as one short line, whatever the file put in it. */
function quoted(value: unknown, limit: number): string {
  if (value === undefined || value === null) return "(nothing recorded)";
  return oneLine(typeof value === "string" ? value : String(value), limit);
}

function definitionHint(note: HistoryNote): string {
  // The field's *shape* is checked here, not only at the write (R4-01's lesson, R5-03's crash): a JSON
  // string has a `length` and a `slice` but no `map`, so the old truthiness test let one hand-written
  // record throw out of the whole listing. A field that is not an array contributes no hint; the rest
  // of the line still says what the cell was.
  const names: readonly unknown[] = Array.isArray(note.definitions) ? note.definitions : [];
  if (names.length === 0) return "";
  // Shortened where it is quoted: these names came out of a history file written by some earlier
  // process, and this text goes out with every request of every later session (R3-01).
  const shown = names
    .slice(0, 6)
    .map((name) => oneLine(typeof name === "string" ? name : String(name), DEFINITION_HINT_NAME_CHARS))
    .join(", ");
  const more = names.length > 6 ? `, +${names.length - 6} more` : "";
  return ` (defined: ${shown}${more})`;
}

/** The history file was cut off after this record; say so instead of pretending it is the newest. */
function tornHint(note: HistoryNote): string {
  return note.torn ? ` (+${note.torn} unreadable record${note.torn > 1 ? "s" : ""} after it)` : "";
}
