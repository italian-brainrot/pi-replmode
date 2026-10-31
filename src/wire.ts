/**
 * The wire format, mirrored from `python/replmode/wire.py`.
 *
 * Two independent streams come back from a channel daemon:
 *
 *   - its **stdout** carries JSON lines (protocol frames) and nothing else;
 *   - its **stderr** is the capture stream: every byte the user's code, a subprocess, or a C
 *     library writes to fd 1 or fd 2, raw, with `PIRB` sentinels at exec boundaries.
 *
 * The streams are separate pipes, so raw output can never corrupt a frame — but it also means an
 * `exec_end` frame can overtake the cell's own output. `CaptureSplitter` is what lets the host wait
 * for the closing sentinel before it returns a result.
 */

// ── Frames ───────────────────────────────────────────────────────────────────

/** Host → daemon. */
export type HostFrame =
  | { t: "execute"; id: string; code: string }
  | { t: "setvar"; name: string; path?: string; text?: string }
  | { t: "interrupt" }
  | { t: "shutdown" };

export type ExecStatus = "ok" | "error" | "interrupted";

/** Daemon → host. */
export type DaemonFrame =
  | {
      t: "ready";
      channel: string;
      pid: number;
      ppid: number;
      cwd: string;
      python: string;
      ipython: string;
      startup_ms: number;
      log: string;
    }
  | {
      t: "exec_end";
      id: string;
      ok: boolean;
      status: ExecStatus;
      elapsed: number;
      ename?: string | null;
      evalue?: string | null;
      traceback?: string;
      definitions?: string[];
    }
  | { t: "log"; level: string; text: string }
  | { t: "display"; id: string; mimes: Record<string, string> }
  | { t: "call"; id: string; kind: string; args: unknown }
  | { t: "fatal"; error: string; traceback?: string };

export function parseFrame(line: string): DaemonFrame | undefined {
  try {
    const parsed = JSON.parse(line) as DaemonFrame;
    return parsed && typeof parsed === "object" && typeof parsed.t === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ── Capture stream ───────────────────────────────────────────────────────────

/** `\0`, record separator, tag, record separator — then the exec id and a newline. */
export const SENTINEL_PREFIX = Buffer.from([0x00, 0x1e, 0x50, 0x49, 0x52, 0x42, 0x1e]);

const EXEC_ID = /^[a-z0-9-]{1,64}$/;

export function isExecId(value: string): boolean {
  return EXEC_ID.test(value);
}

export function sentinelFor(id: string): Buffer {
  return Buffer.concat([SENTINEL_PREFIX, Buffer.from(id, "latin1"), Buffer.from([0x0a])]);
}

/**
 * Splits a byte stream on exec-boundary sentinels.
 *
 * Sentinels can straddle any chunk boundary, so a possible partial prefix is held back between
 * calls. Everything that is not part of a sentinel is handed to `onBytes` in order; each complete
 * sentinel (open or close of a block — the daemon writes the same marker before a cell and after
 * it) goes to `onBoundary`, together with the bytes it matched, so the receiver can put a marker it
 * does not own back where it came from: the id alone cannot say whether the marker is a boundary or
 * just data the program printed.
 */
export class CaptureSplitter {
  private pending = Buffer.alloc(0);

  constructor(
    private readonly onBytes: (chunk: Buffer) => void,
    private readonly onBoundary: (id: string, marker: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    const buf = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let offset = 0;

    for (;;) {
      const at = buf.indexOf(SENTINEL_PREFIX, offset);
      if (at < 0) {
        // Hold back only the bytes that could actually begin a sentinel. Holding a fixed tail
        // instead would delay ordinary output by five bytes for no reason.
        const hold = partialPrefixLength(buf, offset);
        const emitUntil = buf.length - hold;
        if (emitUntil > offset) this.onBytes(buf.subarray(offset, emitUntil));
        this.pending = hold > 0 ? Buffer.from(buf.subarray(emitUntil)) : Buffer.alloc(0);
        return;
      }

      if (at > offset) this.onBytes(buf.subarray(offset, at));

      const newline = buf.indexOf(0x0a, at + SENTINEL_PREFIX.length);
      if (newline < 0) {
        // The id is not complete yet. A sentinel with no newline in the next 256 bytes is not a
        // sentinel, so emit it as data rather than waiting forever.
        if (buf.length - at > 256) {
          this.onBytes(buf.subarray(at, at + SENTINEL_PREFIX.length));
          offset = at + SENTINEL_PREFIX.length;
          continue;
        }
        this.pending = Buffer.from(buf.subarray(at));
        return;
      }

      const marker = buf.subarray(at, newline + 1);
      const id = marker.subarray(SENTINEL_PREFIX.length, marker.length - 1).toString("latin1");
      this.onBoundary(isExecId(id) ? id : "", marker);
      offset = newline + 1;
    }
  }

  /** Anything held back at the end of the stream, as data. */
  drain(): Buffer {
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }
}

/** Longest suffix of `buf` (after `from`) that is a prefix of a sentinel. */
function partialPrefixLength(buf: Buffer, from: number): number {
  const max = Math.min(SENTINEL_PREFIX.length - 1, buf.length - from);
  for (let length = max; length > 0; length--) {
    const start = buf.length - length;
    let matches = true;
    for (let i = 0; i < length; i++) {
      if (buf[start + i] !== SENTINEL_PREFIX[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

/** Remove boundary markers from captured text, for the version shown to the model. */
const SENTINEL_TEXT = /\x00\x1ePIRB\x1e[a-z0-9-]*\n/g;

export function stripSentinels(text: string): string {
  return text.replace(SENTINEL_TEXT, "");
}
