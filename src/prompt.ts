/**
 * The model-facing prompt surface.
 *
 * One `replmode` section, rendered once per session and then left alone: pi diffs prompt sections
 * against the system message it is replaying, so a section that changes mid-session is written into
 * the transcript again and breaks the provider's prompt cache from there down. The only thing that
 * may change it is a session boundary (`session_start`), which is where the "channels from the
 * previous session are gone" note belongs.
 */

import { formatDuration, oneLine } from "./format.ts";
import type { HistoryNote } from "./manager.ts";

export const SECTION_NAME = "replmode";

/** How much of a remembered name the section quotes (R3-01). */
const DEFINITION_HINT_NAME_CHARS = 60;
/**
 * How much of a record's own fields the section quotes, bounded on the **read** path (R4-01). The write
 * path has clipped these since pass 3, but a history file may have been written by a build that did
 * not — or by something that is not this program at all, which is exactly what F3-04 assumed about the
 * remembered definitions and why it clipped them here too.
 */
const HISTORY_CHANNEL_NAME_CHARS = 200;
const HISTORY_CODE_HINT_CHARS = 400;
const HISTORY_STATUS_HINT_CHARS = 40;
/**
 * Characters that would reshape the section rather than be quoted by it: any control character, and the
 * Unicode line separators that are not control characters. A channel name may legally contain them —
 * `run` only refuses a name that is too long — and the section is a list of one-line notes, so a name
 * holding one can add a line of its own choosing to the system prompt of every later session. Marks and
 * joiners that cannot break a line (bidi controls, zero-width joiners) are still quoted as they came.
 */
const UNQUOTABLE = /[\p{Cc}\u2028\u2029]/u;
/** What the section says instead of quoting a name it cannot put on a line. */
const UNQUOTABLE_NAME = "(a channel whose name this section cannot print)";

/** The stable part: what the REPL is and what the contract around it is. */
export const SECTION_LINES: string[] = [
  "Everything runs in a stateful IPython REPL (`run`), which stands in for a shell, a reader, and an editor:",
  'read a file with `open(path).read()`, write one with `open(path, "w").write(text)`, run a command with',
  "`!cmd` or `subprocess.run([...])`, and use `pathlib`/`glob`/`grep` as you like.",
  "",
  "- State is per channel and lasts across calls: variables, imports, and functions you defined are still",
  "  there next time. Write the tool you wish you had as a Python function, then call it.",
  "- A trailing expression shows its repr, like a REPL. Magics, `!cmd`, and top-level `await` work.",
  "- `channel` picks an isolated REPL (its own variables and process); channels run concurrently. A channel",
  "  with a cell in the background refuses new work until that cell finishes. Channels are capped (default 4):",
  "  at the cap the idlest one is retired with its variables, and if they are all busy a new one is refused.",
  "- A cell that passes its `timeout` is not killed: it keeps running in the background, you get a task ID",
  "  and a log path, and its channel is busy. `bg_wait` waits for any task and lists them all; `bg_stop`",
  "  interrupts one with SIGINT, which ends the cell and keeps the channel's variables. `bg_stop` with",
  "  `kill: true` takes the whole channel down instead: it ends the servers, builds and subprocesses in",
  "  the process group it kills (a child that left that group survives), and it loses every variable",
  "  in the channel.",
  "- Output over 50 000 characters is cut, head and tail kept; the whole text is written to a log file and",
  "  bound to a global like `_out_a91f0c` in that channel, so the next cell can slice it.",
  "- A cell that raises returns its traceback, and the channel keeps everything it had.",
  "- `pi.channel`, `pi.cwd`, `pi.python_version`, and `pi.ipython_version` say where you are.",
];

/** The part that can only be known at a session boundary. */
export function lostChannelsLines(notes: HistoryNote[]): string[] {
  if (notes.length === 0) return [];
  return [
    "",
    "These channels ran in an earlier pi process and are gone now — their variables were lost:",
    ...notes.map((note) => lostChannelLine(note)),
    "Nothing from that listing is bound; re-create what you need instead of assuming it is there.",
  ];
}

/**
 * One remembered channel, as one line of the section.
 *
 * The line is built inside a `try` because the record it reads came from a file this build did not
 * necessarily write: a `TypeError` from here escapes `session_start`, pi reports handler errors without
 * ending the session, and what the model gets is no `replmode` section at all — or, in a process that
 * rendered one before, the *previous* session's, which names channels that are live again and omits the
 * ones that went since. One unreadable record costs its own line and nothing else (R5-03).
 */
function lostChannelLine(note: HistoryNote): string {
  const label = historyChannelLabel(note);
  try {
    return `  ${label}: last cell ${quoted(note.status, HISTORY_STATUS_HINT_CHARS)} in ${formatDuration(note.elapsed)} \u2014 ${quoted(note.code, HISTORY_CODE_HINT_CHARS)}${definitionHint(note)}${tornHint(note)}`;
  } catch {
    return `  ${label}: (a record this section could not read)`;
  }
}

/**
 * The name the section and the restart notification quote for a remembered channel (R4-01).
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
  // record throw out of the whole section. A field that is not an array contributes no hint; the rest
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

export function renderSection(notes: HistoryNote[]): string {
  return [...SECTION_LINES, ...lostChannelsLines(notes)].join("\n");
}
