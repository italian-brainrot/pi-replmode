/**
 * A channel: one daemon process, its two output streams, and the cells running on it.
 *
 * The host never kills a channel to end a cell — it sends SIGINT, which IPython turns into a
 * KeyboardInterrupt inside the cell and recovers from. Killing happens only when the whole channel
 * is being closed, and then it is a group kill, so anything the cell started dies with it.
 *
 * Output handling is the subtle part. Frame delivery (stdout) and output capture (stderr) are
 * separate pipes with no ordering between them, so an exec is finished only when *both* its
 * `exec_end` frame and its closing sentinel have arrived. Every byte of a cell's output is streamed
 * to a log file as it arrives, which is what makes a cell that runs past its timeout safe to
 * detach: the log is already where the output is, wherever the host happens to be looking.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { PythonEnv } from "./env.ts";
import { MAX_READ_BYTES, type Truncation, truncateMiddle } from "./format.ts";
import { DAEMON_LOG_DIR, EXEC_LOG_DIR, ensureDirs, IPYTHON_DIR, PYTHON_PACKAGE_DIR } from "./paths.ts";
import { CaptureSplitter, type DaemonFrame, type ExecStatus, type HostFrame, parseFrame, stripSentinels } from "./wire.ts";

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/** Frame buffer ceiling: a runaway or desynced daemon must not exhaust the host's memory. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const READY_TIMEOUT_MS = 120_000;
/** How long a missing closing sentinel is tolerated before the exec is called finished anyway. */
const SENTINEL_GRACE_MS = 750;
/** How long an interrupt is given before an aborted call gives up and backgrounds the cell. */
const INTERRUPT_GRACE_MS = 3000;
/** Output streamed to the UI while a foreground cell runs. */
const PARTIAL_PREVIEW_BYTES = 4096;
/** A channel keeps this many finished exec records, for listings and history. */
const EXEC_RECORD_LIMIT = 100;
/** Daemon `log` frames kept for context on a failed call. */
const DAEMON_NOTE_LIMIT = 40;

export type ReadyFrame = Extract<DaemonFrame, { t: "ready" }>;
export type ExecEndFrame = Extract<DaemonFrame, { t: "exec_end" }>;

export interface ChannelStart {
  name: string;
  cwd: string;
  env: PythonEnv;
}

export type ExecOutcome = "finished" | "detached" | "abandoned" | "dead";

/** One cell, from the moment it is sent until its frame and its capture block have both landed. */
export class Exec {
  readonly startedAt = Date.now();
  finishedAt?: number;
  status: "running" | ExecStatus | "dead" = "running";
  frame?: ExecEndFrame;
  blockOpen = false;
  blockClosed = false;
  settled = false;
  /** True once this exec is a background task: listed by bg_wait, waited on, stoppable. */
  backgrounded = false;
  killRequested = false;
  /** Set when the channel's process died underneath this exec. */
  deathNote?: string;
  outputTruncated = false;

  readonly done: Promise<void>;
  private settle: (() => void) | undefined;
  private graceTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly id: string,
    readonly code: string,
    readonly logPath: string,
    /** The channel that owns this cell: its process, and where to send follow-up frames. */
    readonly channel: Channel,
    private logFd: number | null,
  ) {
    this.done = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
  }

  get channelName(): string {
    return this.channel.name;
  }

  write(chunk: Buffer): void {
    if (this.logFd === null) return;
    try {
      writeSync(this.logFd, chunk);
    } catch {
      // A full disk or a deleted log must not cost the cell its output.
    }
  }

  closeLog(): void {
    if (this.logFd === null) return;
    try {
      closeSync(this.logFd);
    } catch {
      // Already closed.
    }
    this.logFd = null;
  }

  get elapsed(): number {
    return ((this.finishedAt ?? Date.now()) - this.startedAt) / 1000;
  }

  get running(): boolean {
    return !this.settled;
  }

  logSize(): number {
    try {
      return statSync(this.logPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Resolve `done` once the frame and the capture block have both landed, or the channel died.
   *
   * The grace timer covers output that never reaches us again — code that redirected or closed
   * fd 1 and 2 — because then the closing sentinel is never written, and waiting for it would hang
   * the tool call forever.
   */
  considerSettle(): void {
    if (this.settled) return;
    if (!this.frame && this.status === "running") return;
    if (!this.blockClosed) {
      if (!this.graceTimer) {
        const timer = setTimeout(() => this.finalize(), SENTINEL_GRACE_MS);
        timer.unref?.();
        this.graceTimer = timer;
      }
      return;
    }
    this.finalize();
  }

  finalize(): void {
    if (this.settled) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.frame) this.status = this.frame.status;
    else if (this.status === "running") this.status = "dead";
    this.finishedAt = Date.now();
    this.closeLog();
    this.settled = true;
    this.settle?.();
  }
}

export class ChannelBusyError extends Error {
  constructor(
    readonly channel: string,
    readonly taskId: string,
  ) {
    super(`channel "${channel}" is busy: ${taskId} is still running (bg_wait to wait, bg_stop to stop)`);
    this.name = "ChannelBusyError";
  }
}

export class Channel {
  readonly name: string;
  readonly cwd: string;
  readonly env: PythonEnv;
  readonly daemonLogPath: string;
  readonly execs = new Map<string, Exec>();
  readonly pid: number;

  ready?: ReadyFrame;
  closed = false;
  deathNote?: string;
  lastUsed = Date.now();
  /** The exec occupying the channel right now, foreground or backgrounded. */
  current?: Exec;

  private readonly proc: ChildProcess;
  private readonly splitter: CaptureSplitter;
  private frameBuffer = "";
  private loose: Buffer[] = [];
  private sink: Exec | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly daemonNotes: string[] = [];
  private readySettle: (frame: ReadyFrame) => void = () => {};
  private readyFail: (error: Error) => void = () => {};

  readonly readyPromise: Promise<ReadyFrame>;

  constructor(
    readonly start: ChannelStart,
    proc: ChildProcess,
  ) {
    this.name = start.name;
    this.cwd = start.cwd;
    this.env = start.env;
    this.pid = proc.pid ?? -1;
    this.proc = proc;
    this.daemonLogPath = join(DAEMON_LOG_DIR, `${safeChannelName(start.name)}.log`);

    this.readyPromise = new Promise<ReadyFrame>((resolve, reject) => {
      this.readySettle = resolve;
      this.readyFail = reject;
    });

    this.splitter = new CaptureSplitter(
      (chunk) => this.writeToSink(chunk),
      (id) => this.onBoundary(id),
    );
    this.attach(proc);
  }

  // ── Streams ────────────────────────────────────────────────────────────────

  private attach(proc: ChildProcess): void {
    proc.stdout?.on("data", (chunk: Buffer) => this.onFrameBytes(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => this.splitter.push(chunk));
    proc.stdin?.on("error", () => {
      // EPIPE the moment the daemon dies; the exit handler reports what actually happened.
    });
    proc.on("exit", (code, signal) => this.onExit(code, signal));
    proc.on("error", (error) => this.onExit(null, null, error.message));
  }

  private onFrameBytes(chunk: Buffer): void {
    this.frameBuffer += chunk.toString("utf8");
    if (this.frameBuffer.length > MAX_FRAME_BYTES) {
      this.note(`dropped ${this.frameBuffer.length} bytes of unframed daemon output`);
      this.frameBuffer = "";
      return;
    }
    for (;;) {
      const newline = this.frameBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.frameBuffer.slice(0, newline);
      this.frameBuffer = this.frameBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      const frame = parseFrame(line);
      if (!frame) {
        this.note(`non-protocol line from the daemon: ${line.slice(0, 200)}`);
        continue;
      }
      this.onFrame(frame);
    }
  }

  private onFrame(frame: DaemonFrame): void {
    switch (frame.t) {
      case "ready":
        this.ready = frame;
        this.readySettle(frame);
        return;
      case "exec_end": {
        const exec = this.execs.get(frame.id);
        if (!exec) {
          this.note(`exec_end for unknown exec ${frame.id}`);
          return;
        }
        exec.frame = frame;
        exec.status = frame.status;
        exec.considerSettle();
        return;
      }
      case "log":
        this.note(`${frame.level}: ${frame.text}`);
        return;
      case "fatal":
        this.note(`daemon reported a fatal error: ${frame.error}${frame.traceback ? `\n${frame.traceback}` : ""}`);
        return;
      case "display":
        // Rich display lands in M3; recognised so it is never mistaken for noise.
        return;
      default:
        this.note(`unexpected frame from the daemon: ${JSON.stringify(frame).slice(0, 200)}`);
    }
  }

  private writeToSink(chunk: Buffer): void {
    if (this.sink) this.sink.write(chunk);
    else this.loose.push(chunk);
  }

  private onBoundary(id: string): void {
    const exec = id ? this.execs.get(id) : undefined;
    if (!exec) {
      // A marker from an exec this host forgot, or a false positive in the output. Put the following
      // bytes in no block rather than guessing at which one they belong to.
      this.sink = null;
      return;
    }
    if (!exec.blockOpen) {
      exec.blockOpen = true;
      this.sink = exec;
      // Capture that arrived with no block open (startup warnings, a previous cell's late thread
      // output) is attached to the block that follows it, so it is never invisible.
      if (this.loose.length > 0) {
        exec.write(Buffer.concat(this.loose));
        this.loose = [];
      }
      return;
    }
    this.sink = null;
    exec.blockClosed = true;
    exec.considerSettle();
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, error?: string): void {
    if (this.closed) return;
    this.closed = true;
    const how = error ?? `exit code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}`;
    this.deathNote = `the Python process behind channel "${this.name}" ended (${how})`;
    this.flushLoose();
    for (const exec of this.execs.values()) {
      if (exec.settled) continue;
      exec.deathNote = this.deathNote;
      if (exec.status === "running") exec.status = exec.killRequested ? "interrupted" : "dead";
      exec.finalize();
    }
    this.readyFail(new Error(`${this.deathNote}${this.startupOutput() ? `:\n${this.startupOutput()}` : ""}`));
  }

  /** Capture that arrived while no block was open, as text: a daemon that dies at startup leaves its
   *  traceback here, and that is the one thing worth reporting. */
  startupOutput(): string {
    return Buffer.concat(this.loose).toString("utf8").trim();
  }

  private flushLoose(): void {
    if (this.loose.length === 0) return;
    const trailing = Buffer.concat(this.loose);
    this.loose = [];
    // This is a cell's output arriving after the cell ended; the newest record keeps it.
    const last = [...this.execs.values()].at(-1);
    if (last) last.write(trailing);
  }

  private note(text: string): void {
    this.daemonNotes.push(text);
    if (this.daemonNotes.length > DAEMON_NOTE_LIMIT) this.daemonNotes.shift();
  }

  /** Anything the daemon said about itself, oldest first. */
  notes(): string[] {
    return [...this.daemonNotes];
  }

  // ── Frames out ─────────────────────────────────────────────────────────────

  send(frame: HostFrame): void {
    if (this.closed) throw new Error(this.deathNote ?? `channel "${this.name}" is closed`);
    this.proc.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  // ── Execs ──────────────────────────────────────────────────────────────────

  /** The backgrounded cell that owns this channel, if there is one: the spec forbids running on it. */
  busyTask(): Exec | undefined {
    return this.current?.running && this.current.backgrounded ? this.current : undefined;
  }

  begin(code: string): Exec {
    if (this.closed) throw new Error(this.deathNote ?? `channel "${this.name}" is closed`);
    mkdirSync(EXEC_LOG_DIR, { recursive: true });
    const id = newExecId(this.execs);
    const logPath = join(EXEC_LOG_DIR, `${id}.log`);
    const exec = new Exec(id, code, logPath, this, openSync(logPath, "w"));
    this.execs.set(id, exec);
    this.current = exec;
    this.lastUsed = Date.now();
    this.trimRecords();
    return exec;
  }

  byId(id: string): Exec | undefined {
    return this.execs.get(id);
  }

  private trimRecords(): void {
    if (this.execs.size <= EXEC_RECORD_LIMIT) return;
    for (const [id, exec] of this.execs) {
      if (exec === this.current || !exec.settled) continue;
      this.execs.delete(id);
      if (this.execs.size <= EXEC_RECORD_LIMIT) return;
    }
  }

  /**
   * Wait for an exec without ever killing it: a timeout or an abort detaches the *call*, it does not
   * end the cell. Only `interrupt()` stops a cell, and it stops it as an interrupt, which leaves the
   * channel's state intact.
   */
  async wait(exec: Exec, timeoutSec: number, signal?: AbortSignal): Promise<ExecOutcome> {
    const racers: Promise<"done" | "timeout" | "abort">[] = [exec.done.then(() => "done" as const)];
    const cleanup: (() => void)[] = [];

    if (timeoutSec > 0) {
      const timer = sleep(timeoutSec * 1000);
      racers.push(timer.promise.then(() => "timeout" as const));
      cleanup.push(() => timer.cancel());
    }
    if (signal) {
      const abort = abortWatch(signal);
      racers.push(abort.promise.then(() => "abort" as const));
      cleanup.push(() => abort.off());
    }

    try {
      const outcome = await Promise.race(racers);

      // Settled one way or another: a frame means the cell finished, its absence means the channel died.
      if (exec.settled) return exec.frame ? "finished" : "dead";

      if (outcome === "abort") {
        this.interrupt();
        const grace = sleep(INTERRUPT_GRACE_MS);
        await Promise.race([exec.done, grace.promise]);
        grace.cancel();
        if (exec.settled) return exec.frame ? "finished" : "dead";
        // The cell ignored the interrupt. Leave it running rather than kill the channel: that is the
        // caller's decision, and killing loses every variable in it.
        exec.backgrounded = true;
        return "abandoned";
      }

      // Out of foreground time: the cell keeps running and the log keeps filling.
      exec.backgrounded = true;
      return "detached";
    } finally {
      for (const off of cleanup) off();
    }
  }

  /** SIGINT: the cell dies, the channel survives. This is the only stop that keeps the variables. */
  interrupt(): void {
    if (this.closed) return;
    if (this.current) this.current.killRequested = true;
    try {
      process.kill(this.pid, "SIGINT");
    } catch {
      // Already gone; the exit handler will have said so.
    }
  }

  /** Read back what the cell printed, windowed if the log is enormous, then cut to the limit. */
  readOutput(exec: Exec, maxChars: number): { text: string; truncation: Truncation; windowed: boolean } {
    const { text, windowed } = readLog(exec.logPath);
    const truncation = truncateMiddle(text, maxChars);
    exec.outputTruncated = truncation.truncated;
    return { text, truncation, windowed };
  }

  /** Bind the full capture of a finished exec to a global, so the next cell can slice it. */
  bindVar(name: string, path: string): void {
    try {
      this.send({ t: "setvar", name, path });
    } catch {
      // A dead channel cannot bind a variable; the result still carries the log path.
    }
  }

  // ── Per-channel mutex ──────────────────────────────────────────────────────

  /**
   * Serialize this channel's calls. Two `run` calls in one channel queue rather than interleave, so
   * the second one meets the busy-channel rule with the first one's state already settled.
   */
  async withLock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work);
    this.lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  /** Ask the daemon to exit, then take its process group with it if it does not. */
  async close(graceMs = 3000): Promise<void> {
    if (this.closed) return;
    try {
      this.send({ t: "shutdown" });
    } catch {
      // Already dying.
    }
    const exited = this.exitPromise();
    const first = sleep(graceMs);
    await Promise.race([exited, first.promise]);
    first.cancel();
    if (this.closed) return;
    this.killGroup("SIGTERM");
    const second = sleep(1500);
    await Promise.race([exited, second.promise]);
    second.cancel();
    this.killGroup("SIGKILL");
  }

  exitPromise(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => this.proc.once("exit", () => resolve()));
  }

  private killGroup(signal: NodeJS.Signals): void {
    for (const target of [-this.pid, this.pid]) {
      try {
        process.kill(target, signal);
        return;
      } catch {
        // The group may be gone while the leader lives on, or vice versa.
      }
    }
  }

  /** The tail of a running cell's output, for `onUpdate`. */
  preview(exec: Exec): string {
    return stripSentinels(readTail(exec.logPath, PARTIAL_PREVIEW_BYTES)).trimEnd();
  }
}

// ── Starting a channel ───────────────────────────────────────────────────────

export async function startChannel(start: ChannelStart): Promise<Channel> {
  ensureDirs();
  const channel = new Channel(
    start,
    spawn(
      start.env.python,
      ["-m", "replmode", "--channel", start.name, "--log", join(DAEMON_LOG_DIR, `${safeChannelName(start.name)}.log`), "--cwd", start.cwd],
      {
        cwd: start.cwd,
        // Its own process group: Ctrl-C in the terminal belongs to pi, and closing a channel takes
        // anything the cell started with it.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONPATH: PYTHON_PACKAGE_DIR,
          PYTHONUNBUFFERED: "1",
          IPYTHONDIR: join(IPYTHON_DIR, safeChannelName(start.name)),
          PYTHONWARNINGS: process.env.PYTHONWARNINGS ?? "default",
        },
      },
    ),
  );

  const timeout = sleep(READY_TIMEOUT_MS);
  try {
    const ready = await Promise.race([
      channel.readyPromise,
      timeout.promise.then(() => {
        throw new Error(`the channel daemon did not report ready within ${READY_TIMEOUT_MS / 1000}s`);
      }),
    ]);
    channel.ready = ready;
    return channel;
  } catch (error) {
    // Nothing is half-started: a channel that never became ready is closed and reaped.
    void channel.close(500);
    throw error;
  } finally {
    timeout.cancel();
  }
}

// ── Log reading ──────────────────────────────────────────────────────────────

/** Read a log whole when it is small, and its tail with a note when it is not. */
export function readLog(path: string, cap = MAX_READ_BYTES): { text: string; windowed: boolean } {
  try {
    const size = statSync(path).size;
    if (size === 0) return { text: "", windowed: false };
    if (size <= cap) return { text: stripSentinels(readFileSync(path, "utf8")), windowed: false };

    const buffer = Buffer.alloc(cap);
    const fd = openSync(path, "r");
    try {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      const text = buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        // Drop the partial first line and any split codepoint from the raw byte cut.
        .replace(/^[^\n]*\n/, "")
        .replace(/^\uFFFD+/, "");
      return { text: stripSentinels(text), windowed: true };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: "", windowed: false };
  }
}

export function readTail(path: string, maxBytes: number): string {
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const want = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(want);
    const fd = openSync(path, "r");
    try {
      const current = statSync(path).size;
      const bytesRead = readSync(fd, buffer, 0, want, Math.max(0, current - want));
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

export function newExecId(taken: Map<string, Exec>): string {
  let id: string;
  do {
    let suffix = "";
    for (let i = 0; i < 8; i++) suffix += ID_ALPHABET[randomInt(0, ID_ALPHABET.length)];
    id = `repl-${suffix}`;
  } while (taken.has(id));
  return id;
}

/** Channel names come from the model and become file names. */
export function safeChannelName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "channel";
}

interface Sleeper {
  promise: Promise<void>;
  cancel(): void;
}

function sleep(ms: number): Sleeper {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function abortWatch(signal: AbortSignal): { promise: Promise<void>; off: () => void } {
  let off = () => {};
  const promise = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const handler = () => resolve();
    signal.addEventListener("abort", handler, { once: true });
    off = () => signal.removeEventListener("abort", handler);
  });
  return { promise, off };
}
