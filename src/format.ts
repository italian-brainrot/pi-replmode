/**
 * Model-facing text: the output limit, and the notes that explain what was left out.
 *
 * The spec's limit is 50 000 *characters*, and cutting a cell's output in half loses the part of it
 * that explains a failure, so truncation keeps a head and a tail. The full text is never just
 * dropped: it goes to the exec's log file, and the host binds it to a nonce global in the same
 * channel so the next cell can slice it without re-running anything.
 */

import { randomBytes } from "node:crypto";

/** Hard limit on what a `run` call returns, per the spec. */
export const MAX_OUTPUT_CHARS = 50_000;
/** Room kept for the "… not shown …" note, so a truncated result never exceeds the limit. */
const NOTE_RESERVE = 100;
/** A log bigger than this is not read whole; the middle truncation then works on a window. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Cap for `structuredContent.output`, matching pi's own bash tool. */
export const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

export interface Truncation {
  text: string;
  truncated: boolean;
  totalChars: number;
  headChars: number;
  tailChars: number;
  totalLines: number;
  shownLines: number;
  /** True when the text handed in was already a window into a larger log. */
  windowed: boolean;
}

/**
 * Keep `headRatio` of the budget at the start and the rest at the end, both cut at a line break.
 *
 * `totals` is what the whole log holds, when `text` is only a window into it (see `readLog`). Without
 * it the notes would quote the window: "1 000 of 8 388 588 characters" for a 15 MB log, numbers that
 * match nothing the model can go and look at. `totals` is for *reporting only* — where to cut is
 * decided against `text`, or a windowed read loses its tail (R2-01).
 */
export function truncateMiddle(
  text: string,
  maxChars = MAX_OUTPUT_CHARS,
  headRatio = 0.6,
  totals?: { chars: number; lines: number },
): Truncation {
  const totalChars = totals?.chars ?? text.length;
  const totalLines = totals?.lines ?? countLines(text);
  const windowed = totals !== undefined && totals.chars !== text.length;

  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
      totalChars,
      headChars: text.length,
      tailChars: 0,
      totalLines,
      shownLines: countLines(text),
      windowed,
    };
  }

  // The note explaining the cut counts towards the limit too, so it is reserved up front.
  const contentBudget = Math.max(16, maxChars - NOTE_RESERVE);
  const headBudget = Math.floor(contentBudget * headRatio);
  const tailBudget = contentBudget - headBudget;

  // Both cuts are in the coordinates of the text in hand, never of the file it came from: for a
  // windowed read `totalChars` is the size of the whole log, and a tail offset measured in those
  // coordinates starts past the end of the window, which loses the end of the log entirely.
  let headEnd = cutAtLineStart(text, headBudget, Math.floor(headBudget * 0.4));
  let tailStart = cutAtLineEnd(text, text.length - tailBudget, text.length - Math.floor(tailBudget * 0.4));
  if (tailStart <= headEnd) {
    // A single line longer than the whole budget: fall back to a raw character cut.
    headEnd = headBudget;
    tailStart = text.length - tailBudget;
  }

  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);

  return {
    text: `${head}\n\n[... ${Math.max(0, totalChars - head.length - tail.length)} characters and ${Math.max(0, totalLines - countLines(head) - countLines(tail))} lines not shown ...]\n\n${tail}`,
    truncated: true,
    totalChars,
    headChars: head.length,
    tailChars: tail.length,
    totalLines,
    shownLines: countLines(head) + countLines(tail),
    windowed,
  };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) lines++;
  }
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** The largest offset ≤ `budget` that begins a line, so the head never runs over its budget. */
function cutAtLineStart(text: string, budget: number, minimum: number): number {
  if (budget >= text.length) return text.length;
  const newline = text.lastIndexOf("\n", budget - 1);
  if (newline < 0) return budget;
  return Math.max(minimum, newline + 1);
}

/** The smallest offset ≥ `floor` that begins a line, so the tail fits in what is left. */
function cutAtLineEnd(text: string, floor: number, maximum: number): number {
  if (floor <= 0) return 0;
  if (text.charCodeAt(floor - 1) === 0x0a) return floor;
  const newline = text.indexOf("\n", floor - 1);
  // No line begins in range: cut at `floor` rather than dropping the tail's budget.
  if (newline < 0) return floor;
  return Math.min(Math.max(maximum, floor), Math.max(floor, newline + 1));
}

/** A global name to hold truncated output: `_out_` plus a short random suffix. */
export function nonceVarName(): string {
  return `_out_${randomBytes(4).toString("hex")}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "?";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line, shortened, for the task listing. */
export function oneLine(text: string, limit = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
