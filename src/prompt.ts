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
    ...notes.map(
      (note) =>
        `  ${note.channel}: last cell ${note.status} in ${formatDuration(note.elapsed)} \u2014 ${note.code}${definitionHint(note)}${tornHint(note)}`,
    ),
    "Nothing from that listing is bound; re-create what you need instead of assuming it is there.",
  ];
}

function definitionHint(note: HistoryNote): string {
  if (!note.definitions?.length) return "";
  // Shortened where it is quoted: these names came out of a history file written by some earlier
  // process, and this text goes out with every request of every later session (R3-01).
  const shown = note.definitions
    .slice(0, 6)
    .map((name) => oneLine(name, DEFINITION_HINT_NAME_CHARS))
    .join(", ");
  const more = note.definitions.length > 6 ? `, +${note.definitions.length - 6} more` : "";
  return ` (defined: ${shown}${more})`;
}

/** The history file was cut off after this record; say so instead of pretending it is the newest. */
function tornHint(note: HistoryNote): string {
  return note.torn ? ` (+${note.torn} unreadable record${note.torn > 1 ? "s" : ""} after it)` : "";
}

export function renderSection(notes: HistoryNote[]): string {
  return [...SECTION_LINES, ...lostChannelsLines(notes)].join("\n");
}
