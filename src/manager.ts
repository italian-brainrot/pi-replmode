/**
 * The session's REPL state: which channels exist, which cells are running, what is in the
 * background, and what a `run` call should answer.
 *
 * The manager lives on `globalThis`, because pi's `/reload` clears its extension module cache while
 * the Node process and its child pipes survive. A fresh module instance that built its own map would
 * leave the old daemons unreachable — running, unlistable, and unkillable — so `getManager()` picks
 * up whatever this process already has.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type Channel, ChannelBusyError, type Exec, type ExecOutcome, type ReadyFrame, readLog, startChannel } from "./channel.ts";
import { ensureEnv } from "./env.ts";
import { formatDuration, formatSize, MAX_OUTPUT_CHARS, MAX_READ_BYTES, nonceVarName, oneLine, truncateMiddle } from "./format.ts";
import { channelFileStem } from "./names.ts";
import { EXEC_LOG_DIR, ensureDirs, HISTORY_DIR } from "./paths.ts";

const DEFAULT_TIMEOUT_SEC = 60;
export const DEFAULT_BG_WAIT_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = Math.floor(2_147_483_647 / 1000);
/** Live channels per pi process; the idlest idle one is shut down to make room. */
const DEFAULT_MAX_CHANNELS = 4;
/** Exec logs older than this, or beyond this many, are pruned at session_start. */
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_LOGS = 200;
const TASK_REGISTRY_LIMIT = 200;
/** History lines kept per channel. */
const HISTORY_MAX_LINES = 300;
const HISTORY_ROTATE_BYTES = 256 * 1024;
const HISTORY_CODE_CHARS = 400;
/** Listing limits, model-facing. */
const LISTING_MAX_TASKS = 30;
/** How much of the 50 000 a traceback may take before the capture is cut to make room (R2-02). */
const TRACEBACK_SHARE = 0.25;
/** How much of an exception's own message is worth repeating when the traceback already carries it. */
const EVALUE_CHARS = 500;
/** How long an interrupt is given before bg_stop reports the task as unresponsive. */
const STOP_GRACE_MS = 5000;

export type TaskStatus = "running" | "completed" | "failed" | "interrupted" | "dead";

/** There is no room for another channel, and nothing idle to make room with. */
export class ChannelCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelCapacityError";
  }
}

export interface TaskInfo {
  id: string;
  channel: string;
  status: TaskStatus;
  code: string;
  runtimeSeconds: number;
  pid: number;
  logPath: string;
  logExists: boolean;
  lines: number;
  chars: number;
  bytes: number;
  countsPartial: boolean;
  ename?: string | null;
  evalue?: string | null;
}

export interface ReplDetails {
  channel: string;
  id?: string;
  status?: TaskStatus;
  elapsed?: number;
  pid?: number;
  logPath?: string;
  fullOutputPath?: string;
  truncated?: boolean;
  varName?: string;
  definitions?: string[];
  ename?: string | null;
  evalue?: string | null;
  running?: string[];
  finished?: string[];
  tasks?: TaskInfo[];
  timeout?: number;
  channelInfo?: { python: string; ipython: string; cwd: string };
  envDir?: string;
  envCreated?: boolean;
}

export type ReplResult = AgentToolResult<ReplDetails>;

export interface RunParams {
  code: string;
  timeout?: number;
  channel?: string;
}

interface HistoryRecord {
  ts: string;
  id: string;
  channel: string;
  status: TaskStatus;
  elapsed: number;
  code: string;
  definitions?: string[];
  /** Records after the one reported that could not be read — a torn append after a crash. */
  torn?: number;
}

/** What a channel held before this pi process started. */
export interface HistoryNote extends HistoryRecord {}

const MANAGER_KEY = "__piReplmodeManager__";

/** The process-wide manager: a reload re-adopts the live daemons instead of orphaning them. */
export function getManager(): ReplManager {
  const host = globalThis as unknown as Record<string, ReplManager | undefined>;
  host[MANAGER_KEY] ??= new ReplManager();
  return host[MANAGER_KEY];
}

export class ReplManager {
  readonly channels = new Map<string, Channel>();
  /** Execs that became background tasks, in the order they went to the background. */
  readonly tasks = new Map<string, Exec>();

  private readonly starting = new Map<string, Promise<Channel>>();
  private readonly listeners = new Set<(exec: Exec) => void>();
  /** Read per channel creation, so the cap can be changed without rebuilding the manager. */
  private get maxChannels(): number {
    return intEnv("PI_REPLMODE_MAX_CHANNELS", DEFAULT_MAX_CHANNELS);
  }

  // ── Channels ───────────────────────────────────────────────────────────────

  private async getChannel(name: string, cwd: string, onProgress: (message: string) => void): Promise<Channel> {
    const existing = this.channels.get(name);
    if (existing && !existing.closed) return existing;
    if (existing) this.channels.delete(name);

    const pending = this.starting.get(name);
    if (pending) return pending;

    const starting = this.createChannel(name, cwd, onProgress);
    this.starting.set(name, starting);
    try {
      return await starting;
    } finally {
      this.starting.delete(name);
    }
  }

  private async createChannel(name: string, cwd: string, onProgress: (message: string) => void): Promise<Channel> {
    await this.makeRoom();
    const env = await ensureEnv(onProgress);
    const channel = await startChannel({ name, cwd, env });
    this.channels.set(name, channel);
    return channel;
  }

  /**
   * The cap is about process count: an idle daemon costs about 45 MB.
   *
   * A creation that is still in flight counts as live. `run` is registered parallel and the prompt
   * recommends separate channels for independent work, so a whole set of new channels can be asked for
   * in one tick, and every one of them would otherwise measure the cap against a map its own daemon has
   * not reached yet — N daemons for a cap of 2 (R2-03).
   */
  private async makeRoom(): Promise<void> {
    const live = [...this.channels.values()].filter((channel) => !channel.closed);
    // A name is counted once even in the moment between a daemon coming up and the creation promise
    // being cleared out of `starting`.
    const occupying = new Set([...this.starting.keys(), ...live.map((channel) => channel.name)]);
    if (occupying.size < this.maxChannels) return;

    const idlest = live
      .filter((channel) => !channel.current?.running)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .at(0);
    if (!idlest) {
      throw new ChannelCapacityError(
        `all ${this.maxChannels} pi-replmode channels are busy and the cap (${this.maxChannels}, set with PI_REPLMODE_MAX_CHANNELS) is reached: ` +
          "let a background task finish, stop one with bg_stop, or free a channel with bg_stop {kill: true}",
      );
    }
    await this.shutdownChannel(idlest.name);
  }

  /** Close a channel and everything it started. Its variables go with it. */
  async shutdownChannel(name: string): Promise<boolean> {
    const channel = this.channels.get(name);
    if (!channel) return false;
    this.channels.delete(name);
    await channel.close();
    for (const [id, exec] of [...this.tasks]) {
      if (exec.channelName === name) this.tasks.delete(id);
    }
    return true;
  }

  // ── run ────────────────────────────────────────────────────────────────────

  async run(
    params: RunParams,
    cwd: string,
    signal: AbortSignal | undefined,
    onProgress: (message: string) => void,
    onUpdate?: (partial: ReplResult) => void,
  ): Promise<ReplResult> {
    const code = params.code ?? "";
    if (!code.trim()) throw new Error("run: `code` is empty.");
    const timeoutSec = resolveTimeout(params.timeout);
    const channelName = (params.channel ?? "main").trim() || "main";

    let channel: Channel;
    try {
      channel = await this.getChannel(channelName, cwd, onProgress);
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      // A capacity refusal is not a channel that failed to start — nothing was started, and every
      // other channel in the session is running. Say which of the two the model is being told.
      const refused = error instanceof ChannelCapacityError;
      const status: TaskStatus = refused ? "running" : "dead";
      return {
        content: [{ type: "text", text: refused ? note : `channel "${channelName}" could not start: ${note}` }],
        details: { channel: channelName, status },
        structuredContent: { status, channel: channelName, error: note },
        isError: true,
      };
    }

    return channel.withLock(() => this.runLocked(channel, code, timeoutSec, signal, onUpdate));
  }

  private async runLocked(
    channel: Channel,
    code: string,
    timeoutSec: number,
    signal: AbortSignal | undefined,
    onUpdate?: (partial: ReplResult) => void,
  ): Promise<ReplResult> {
    const busy = channel.busyTask();
    if (busy) throw new ChannelBusyError(channel.name, busy.id);

    const exec = channel.begin(code);
    const banner = this.channelBanner(channel);
    channel.send({ t: "execute", id: exec.id, code });

    // `timeout: 0` means "this is a long-running thing; do not wait for it".
    if (timeoutSec === 0) {
      exec.backgrounded = true;
      this.rememberTask(exec);
      return this.backgroundResult(exec, "started in the background");
    }

    const stopPolling = this.startOutputPolling(channel, exec, onUpdate);
    let outcome: ExecOutcome;
    try {
      outcome = await channel.wait(exec, timeoutSec, signal);
    } finally {
      stopPolling();
      this.rememberTask(exec);
      if (!exec.backgrounded) this.recordHistory(exec);
    }

    switch (outcome) {
      case "detached":
        return this.backgroundResult(exec, `timed out after ${timeoutSec}s and moved to background`);
      case "abandoned":
        return this.backgroundResult(exec, "did not stop after an interrupt and is still running", true);
      case "dead":
        // A cell that got its `exec_end` out before the process went away still has output and a
        // traceback worth showing; `deadResult` is for the ones that never got a frame at all.
        return exec.frame ? this.finishedResult(exec, banner) : this.deadResult(exec, banner);
      default:
        return this.finishedResult(exec, banner);
    }
  }

  /** The first call on a fresh channel says what it is and what starting it cost. */
  private channelBanner(channel: Channel): string[] {
    const ready: ReadyFrame | undefined = channel.ready;
    if (!ready || channel.execs.size !== 1) return [];
    const lines = [
      `[new channel "${channel.name}": python ${ready.python}, ipython ${ready.ipython}, cwd ${ready.cwd}, pid ${ready.pid}, started in ${ready.startup_ms}ms]`,
    ];
    if (channel.env.created) {
      lines.push(`[python environment created in ${channel.env.dir} (${channel.env.backend}, ${channel.env.seconds.toFixed(1)}s)]`);
    }
    return lines;
  }

  private startOutputPolling(channel: Channel, exec: Exec, onUpdate?: (partial: ReplResult) => void): () => void {
    if (!onUpdate) return () => {};
    let last = "";
    const timer = setInterval(() => {
      if (exec.settled) return;
      const text = channel.preview(exec);
      if (text === last) return;
      last = text;
      onUpdate({
        content: [{ type: "text", text }],
        details: { channel: channel.name, id: exec.id, status: "running", logPath: exec.logPath, pid: channel.pid },
      });
    }, 300);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * The answer to a finished cell: its output, then the traceback if it raised, then a note about
   * what did not fit. Truncation never just drops text: the log file keeps the whole thing, and a
   * nonce global in the same channel holds it so the next cell can slice it.
   *
   * The limit covers the whole answer, not just the capture. A traceback is not capture — it arrives in
   * the `exec_end` frame — so it has to be given a share of the budget explicitly, or a cell that raises
   * with data in its message (`ValueError("unparseable: " + blob)`) returns a result of whatever size
   * the data was (R2-02). The full traceback is appended to the exec log first, so shortening it in the
   * result does not lose it.
   */
  private finishedResult(exec: Exec, banner: string[]): ReplResult {
    const read = readLog(exec.logPath);
    // A log read as a tail window is bigger than the text in hand, so the totals quoted to the model
    // come from the file itself rather than from the window.
    const totals = read.windowed ? countOutput(exec.logPath) : undefined;
    const frame = exec.frame;
    const tracebackRaw = frame?.traceback?.trimEnd() ?? "";
    // The traceback gets whatever the capture did not need, and never less than a quarter of the limit,
    // so a cell that printed 8 MB and *then* raised still gets a readable traceback.
    const tracebackBudget = Math.min(
      tracebackRaw.length,
      Math.max(Math.floor(MAX_OUTPUT_CHARS * TRACEBACK_SHARE), MAX_OUTPUT_CHARS - Math.min(read.text.length, MAX_OUTPUT_CHARS)),
    );

    const cut = truncateMiddle(read.text, MAX_OUTPUT_CHARS - tracebackBudget, 0.6, totals && { chars: totals.chars, lines: totals.lines });
    const traceback = truncateMiddle(tracebackRaw, tracebackBudget, 0.65);
    exec.outputTruncated = cut.truncated || traceback.truncated;

    const status = statusOf(exec);
    const gone = status === "dead" || Boolean(exec.deathNote) || exec.channel.closed;
    const blocks: string[] = [...banner];

    const shown = cut.text.replace(/\s+$/, "");
    if (shown.trim()) blocks.push(shown);
    else if (!tracebackRaw) blocks.push("(no output)");

    if (tracebackRaw) blocks.push(traceback.text.trimEnd());

    const notes: string[] = [];
    if (status === "interrupted") notes.push("cell interrupted; the channel and its variables are intact");
    if (gone) {
      // The frame said the cell finished, and the process underneath it is gone: say both rather
      // than letting the next cell discover the loss as a NameError.
      notes.push(exec.deathNote ?? exec.channel.deathNote ?? "the channel's Python process ended");
      notes.push("the channel is gone and its variables are lost; the next run on it starts a fresh one");
    }
    if (read.windowed) notes.push(`the log is bigger than ${formatSize(MAX_READ_BYTES)}; showing its tail`);
    if (exec.channel.hasOutOfBandOutput()) {
      // Everything the channel's processes write goes into one stream. Bytes that arrive between two
      // cells are attributed to the cell that left them running (see `channel.ts`); bytes that arrive
      // while a cell is running are indistinguishable from that cell's own output, so the only honest
      // thing left is to say that this channel has produced output no cell asked for (R2-07).
      notes.push(
        "this channel has output that arrived outside any cell's block, so some of the lines above may come from a process an earlier cell left running rather than from this cell",
      );
    }

    let varName: string | undefined;
    if (cut.truncated || traceback.truncated) {
      // `countOutput` stops counting in very large logs, so say when the total is a floor.
      const atLeast = totals?.partial ? "at least " : "";
      if (cut.truncated) {
        notes.push(
          `output truncated: showing ${cut.headChars} of ${atLeast}${cut.totalChars} characters at the start and ${cut.tailChars} at the end ` +
            `(${cut.shownLines} of ${atLeast}${cut.totalLines} lines)`,
        );
      }
      if (traceback.truncated) {
        exec.appendNote(`\n[full traceback for this cell]\n${tracebackRaw}\n`);
        // Head *and* tail, like the output note: the smoke test caught this one claiming only the head
        // was shown when the tail was on the page too.
        notes.push(
          `traceback truncated: showing ${traceback.headChars} of ${tracebackRaw.length} characters at the start and ${traceback.tailChars} at the end`,
        );
      }
      const what = cut.truncated && traceback.truncated ? "full output and traceback" : cut.truncated ? "full output" : "full traceback";
      if (!exec.channel.closed) {
        varName = nonceVarName();
        exec.channel.bindVar(varName, exec.logPath);
        notes.push(`${what}: ${exec.logPath}, also bound to the global ${varName} in channel "${exec.channelName}"`);
      } else {
        notes.push(`${what}: ${exec.logPath}`);
      }
    }
    if (frame?.definitions?.length) notes.push(`defined by this cell: ${frame.definitions.join(", ")}`);
    if (notes.length > 0) blocks.push(notes.map((note) => `[${note}]`).join("\n"));

    const failed = status === "failed" || status === "interrupted" || status === "dead";
    const kept = cut.truncated || traceback.truncated || read.windowed || exec.backgrounded;
    const evalue = frame?.evalue ? oneLine(frame.evalue, EVALUE_CHARS) : null;

    return {
      content: [{ type: "text", text: blocks.join("\n\n") }],
      details: {
        channel: exec.channelName,
        id: exec.id,
        status,
        elapsed: round(exec.elapsed),
        pid: exec.channel.pid,
        truncated: cut.truncated || traceback.truncated,
        ...(varName ? { varName } : {}),
        ...(kept ? { logPath: exec.logPath, fullOutputPath: exec.logPath } : {}),
        ...(frame?.definitions?.length ? { definitions: frame.definitions } : {}),
        ...(frame?.ename ? { ename: frame.ename, evalue } : {}),
      },
      structuredContent: {
        status,
        channel: exec.channelName,
        output: cut.text.slice(0, 1_048_576),
        truncated: cut.truncated || traceback.truncated,
        ...(kept ? { full_output_path: exec.logPath } : {}),
        ...(varName ? { variable: varName } : {}),
        elapsed_seconds: round(exec.elapsed),
        ...(frame?.ename ? { error: { ename: frame.ename, evalue: evalue ?? "" } } : {}),
      },
      ...(failed ? { isError: true } : {}),
    };
  }

  private backgroundResult(exec: Exec, reason: string, isError = false): ReplResult {
    const preview = readLog(exec.logPath, 8192).text.trim();
    const size = exec.logSize();
    const blocks = [
      `Cell ${reason} with ID: ${exec.id} (channel "${exec.channelName}", pid ${exec.channel.pid}).`,
      `Output is being written to: ${exec.logPath}`,
      ...(preview ? [`Preview:\n${preview}`] : ["(no output yet)"]),
      `Channel "${exec.channelName}" is busy until this cell finishes: run will fail on it, bg_wait waits for it, bg_stop interrupts it.`,
    ];
    if (size > 50 * 1024 * 1024) blocks.push(`Warning: ${exec.logPath} is already ${formatSize(size)}.`);

    return {
      content: [{ type: "text", text: blocks.join("\n\n") }],
      details: {
        channel: exec.channelName,
        id: exec.id,
        status: "running",
        elapsed: round(exec.elapsed),
        pid: exec.channel.pid,
        logPath: exec.logPath,
        fullOutputPath: exec.logPath,
      },
      structuredContent: {
        status: "running",
        task_id: exec.id,
        channel: exec.channelName,
        output_path: exec.logPath,
        elapsed_seconds: round(exec.elapsed),
      },
      ...(isError ? { isError: true } : {}),
    };
  }

  private deadResult(exec: Exec, banner: string[]): ReplResult {
    const { text } = readLog(exec.logPath, 1024 * 1024);
    // A dead channel's result has to fit the same limit as any other: the capture it managed to
    // stream can be megabytes, and there is no later cell to bind a global for.
    const cut = truncateMiddle(text, Math.floor(MAX_OUTPUT_CHARS * 0.6), 0.6);
    const notes = exec.channel.notes().slice(-6);
    const blocks = [
      ...banner,
      cut.text.trim() || "(no output)",
      `[${exec.deathNote ?? "the channel's Python process ended"}]`,
      ...(cut.truncated ? [`[output truncated: the whole capture is in ${exec.logPath}]`] : []),
      ...(notes.length > 0 ? [`daemon said:\n${notes.join("\n")}`] : []),
      "[the channel is gone and its variables are lost; the next run on it starts a fresh one]",
    ];
    return {
      content: [{ type: "text", text: blocks.join("\n\n") }],
      details: {
        channel: exec.channelName,
        id: exec.id,
        status: "dead",
        elapsed: round(exec.elapsed),
        truncated: cut.truncated,
        logPath: exec.logPath,
        fullOutputPath: exec.logPath,
      },
      structuredContent: {
        status: "dead",
        channel: exec.channelName,
        output: cut.text.slice(0, 1_048_576),
        truncated: cut.truncated,
        full_output_path: exec.logPath,
        elapsed_seconds: round(exec.elapsed),
      },
      isError: true,
    };
  }

  // ── Background tasks ───────────────────────────────────────────────────────

  private rememberTask(exec: Exec): void {
    if (!exec.backgrounded) return;
    this.tasks.set(exec.id, exec);
    if (this.tasks.size > TASK_REGISTRY_LIMIT) {
      for (const [id, task] of this.tasks) {
        if (!task.settled) continue;
        this.tasks.delete(id);
        if (this.tasks.size <= TASK_REGISTRY_LIMIT) break;
      }
    }
    // A background cell is recorded when it actually finishes, so history carries its real status.
    void exec.done.then(() => this.recordHistory(exec));
    // A wait that started before this cell went to the background should be waiting on it too.
    for (const listener of this.listeners) listener(exec);
  }

  findExec(id: string): Exec | undefined {
    for (const channel of this.channels.values()) {
      const found = channel.byId(id);
      if (found) return found;
    }
    return this.tasks.get(id);
  }

  onTask(fn: (exec: Exec) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async bgWait(timeoutSec: number, signal: AbortSignal | undefined): Promise<ReplResult> {
    const watched = new Map<string, Exec>();
    for (const exec of this.tasks.values()) {
      if (!exec.settled) watched.set(exec.id, exec);
    }
    if (watched.size === 0) return this.waitResult("No background tasks are running.", "none", watched);

    const off = this.onTask((exec) => {
      if (!exec.settled && this.tasks.has(exec.id)) watched.set(exec.id, exec);
    });

    const racers: Promise<"job" | "timeout" | "aborted">[] = [
      Promise.race([...watched.values()].map((exec) => exec.done)).then(() => "job" as const),
      sleep(timeoutSec * 1000).then(() => "timeout" as const),
    ];
    const abort = signal ? abortWatch(signal) : undefined;
    if (abort) racers.push(abort.promise.then(() => "aborted" as const));

    let outcome: "job" | "timeout" | "aborted";
    try {
      outcome = await Promise.race(racers);
    } finally {
      off();
      abort?.off();
    }

    const finished = [...watched.values()].filter((exec) => exec.settled).map((exec) => exec.id);
    if (outcome === "timeout")
      return this.waitResult(`Timeout reached (${timeoutSec}s); nothing finished in time.`, "timeout", watched, timeoutSec);
    if (outcome === "aborted") return this.waitResult("Wait aborted; background tasks keep running.", "aborted", watched, undefined, true);
    return this.waitResult(`${finished.length} task(s) finished: ${finished.join(", ")}.`, "job", watched);
  }

  private waitResult(summary: string, outcome: string, watched: Map<string, Exec>, timeoutSec?: number, isError = false): ReplResult {
    const infos = this.taskInfos();
    const running = infos.filter((info) => info.status === "running").map((info) => info.id);
    const finished = [...watched.values()].filter((exec) => exec.settled).map((exec) => exec.id);
    return {
      content: [{ type: "text", text: [summary, ...taskSection(infos)].join("\n") }],
      details: {
        channel: infos[0]?.channel ?? "main",
        running,
        finished,
        tasks: infos,
        ...(timeoutSec !== undefined ? { timeout: timeoutSec } : {}),
      },
      structuredContent: {
        outcome,
        finished,
        running,
        ...(timeoutSec !== undefined ? { timeout: timeoutSec } : {}),
        tasks: infos.map((info) => ({
          id: info.id,
          channel: info.channel,
          status: info.status,
          pid: info.pid,
          runtime_seconds: info.runtimeSeconds,
          log_path: info.logPath,
          lines: info.lines,
          chars: info.chars,
          bytes: info.bytes,
        })),
      },
      ...(isError ? { isError: true } : {}),
    };
  }

  taskInfos(): TaskInfo[] {
    return [...this.tasks.values()]
      .sort((a, b) => {
        const aRunning = !a.settled;
        const bRunning = !b.settled;
        if (aRunning !== bRunning) return aRunning ? -1 : 1;
        return a.startedAt - b.startedAt;
      })
      .map((exec) => {
        const counts = countOutput(exec.logPath);
        return {
          id: exec.id,
          channel: exec.channelName,
          status: statusOf(exec),
          code: oneLine(exec.code, 100),
          runtimeSeconds: round(exec.elapsed),
          pid: exec.channel.pid,
          logPath: exec.logPath,
          logExists: existsSync(exec.logPath),
          lines: counts.lines,
          chars: counts.chars,
          bytes: counts.bytes,
          countsPartial: counts.partial,
          ename: exec.frame?.ename ?? null,
          evalue: exec.frame?.evalue ? oneLine(exec.frame.evalue, EVALUE_CHARS) : null,
        };
      });
  }

  async bgStop(taskId: string, reason: string | undefined, kill: boolean): Promise<ReplResult> {
    const exec = this.findExec(taskId);
    if (!exec) {
      throw new Error(
        `unknown task: ${taskId}. The ID comes from a run that moved to the background; tasks are tracked per pi process and pruned after ${Math.round(RETENTION_MS / 86_400_000)} days.`,
      );
    }

    if (kill) {
      // The escalation: nothing less reaches a cell that ignores SIGINT, and it costs the channel.
      const alive = !exec.channel.closed;
      await this.shutdownChannel(exec.channelName);
      return {
        content: [
          {
            type: "text",
            text:
              `channel "${exec.channelName}" killed${reason ? ` (${reason})` : ""}. The cell was stopped by taking the whole channel down, ` +
              `so its variables are gone.${alive ? "" : " (the channel was already gone)"}`,
          },
        ],
        details: { channel: exec.channelName, id: taskId, status: "dead", logPath: exec.logPath },
        structuredContent: { status: "dead", task_id: taskId, channel: exec.channelName, killed: true },
      };
    }

    if (exec.settled) {
      return {
        content: [
          {
            type: "text",
            text:
              `task ${taskId} already finished (${statusOf(exec)})${reason ? `; stop requested: ${reason}` : ""}` +
              (existsSync(exec.logPath) ? `\nLog: ${exec.logPath}` : ""),
          },
        ],
        details: { channel: exec.channelName, id: taskId, status: statusOf(exec), logPath: exec.logPath },
      };
    }

    exec.killRequested = true;
    exec.channel.interrupt();
    await Promise.race([exec.done, sleep(STOP_GRACE_MS)]);

    if (!exec.settled) {
      return {
        content: [
          {
            type: "text",
            text:
              `task ${taskId} is still running: it did not stop on SIGINT within ${STOP_GRACE_MS / 1000}s. ` +
              "Code that blocks signals, or a C extension holding the GIL, can do that. " +
              "bg_stop with kill: true takes the whole channel down to stop it, which loses that channel's variables.",
          },
        ],
        details: { channel: exec.channelName, id: taskId, status: "running", logPath: exec.logPath, pid: exec.channel.pid },
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: `task ${taskId} stopped (${statusOf(exec)}).\nLog: ${exec.logPath}` }],
      details: { channel: exec.channelName, id: taskId, status: statusOf(exec), logPath: exec.logPath },
      structuredContent: { status: statusOf(exec), task_id: taskId, channel: exec.channelName },
    };
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  pruneRetention(): void {
    ensureDirs();
    let names: string[];
    try {
      names = readdirSync(EXEC_LOG_DIR);
    } catch {
      return;
    }
    const now = Date.now();
    const logs: { name: string; mtimeMs: number }[] = [];
    for (const entry of names) {
      if (!entry.startsWith("repl-") || !entry.endsWith(".log")) continue;
      const path = join(EXEC_LOG_DIR, entry);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (this.findExec(entry.slice(0, -4))?.running) continue;
      if (now - mtimeMs > RETENTION_MS) {
        try {
          unlinkSync(path);
        } catch {
          // Somebody else got there first.
        }
        continue;
      }
      logs.push({ name: entry, mtimeMs });
    }
    for (const entry of logs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(MAX_RETAINED_LOGS)) {
      try {
        unlinkSync(join(EXEC_LOG_DIR, entry.name));
      } catch {
        // Already gone.
      }
    }
  }

  /** The last recorded cell per channel, from this and earlier processes.
   *
   * Keyed by the name the model used, which the record carries. The file name is a sanitised, digested
   * form of it (see `names.ts`) and asking the live channel map with *that* would report a running
   * channel as lost (R2-04).
   */
  lastHistoryByChannel(): Map<string, HistoryRecord> {
    const latest = new Map<string, HistoryRecord>();
    let names: string[];
    try {
      names = readdirSync(HISTORY_DIR);
    } catch {
      return latest;
    }
    for (const entry of names) {
      if (!entry.endsWith(".jsonl")) continue;
      const stem = entry.slice(0, -".jsonl".length);
      try {
        const lines = readFileSync(join(HISTORY_DIR, entry), "utf8")
          .split("\n")
          .filter((line) => line.trim());
        // A crash mid-append leaves a torn record at the end. Reading only the last line would drop
        // the channel from the note entirely; the newest record that parses still says what it held.
        let torn = 0;
        for (let index = lines.length - 1; index >= 0; index--) {
          try {
            const parsed = JSON.parse(lines[index]!) as HistoryRecord;
            if (!parsed || typeof parsed !== "object") throw new Error("not a record");
            const channel = typeof parsed.channel === "string" && parsed.channel ? parsed.channel : stem;
            latest.set(channel, { ...parsed, channel, ...(torn > 0 ? { torn } : {}) });
            break;
          } catch {
            torn++;
          }
        }
      } catch {
        // A corrupt history file is not worth an error.
      }
    }
    return latest;
  }

  /**
   * Channels that ran in an earlier pi process and have no live daemon here. Their variables are
   * gone, and the spec wants the model told so rather than left to rediscover it by hitting a NameError.
   */
  lostChannelNotes(limit = 8): HistoryNote[] {
    const notes: HistoryNote[] = [];
    for (const [channel, record] of this.lastHistoryByChannel()) {
      const live = this.channels.get(channel);
      if (live && !live.closed) continue;
      notes.push(record);
    }
    return notes.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
  }

  private recordHistory(exec: Exec): void {
    const record: HistoryRecord = {
      ts: new Date(exec.finishedAt ?? Date.now()).toISOString(),
      id: exec.id,
      channel: exec.channelName,
      status: statusOf(exec),
      elapsed: round(exec.elapsed),
      code: oneLine(exec.code, HISTORY_CODE_CHARS),
      ...(exec.frame?.definitions?.length ? { definitions: exec.frame.definitions.slice(0, 20) } : {}),
    };
    const path = join(HISTORY_DIR, `${channelFileStem(exec.channelName)}.jsonl`);
    try {
      ensureDirs();
      sealHistoryTail(path);
      appendLine(path, `${JSON.stringify(record)}\n`);
      rotateHistory(path);
    } catch {
      // History is a convenience; losing it must not affect the call.
    }
  }

  /**
   * Session replacement keeps the daemons: a `/reload` re-adopts them through `globalThis`, and
   * `/new` or `/resume` should not silently throw away a dataframe someone was working on.
   * `PI_REPLMODE_KEEP_RUNNING=0` restores the kill-on-everything behaviour.
   */
  async closeAll(reason: string): Promise<void> {
    const keepOnReplacement = process.env.PI_REPLMODE_KEEP_RUNNING !== "0";
    if (reason === "quit" || !keepOnReplacement) await this.quit();
  }

  async quit(): Promise<void> {
    const channels = [...this.channels.values()];
    this.channels.clear();
    await Promise.all(channels.map((channel) => channel.close()));
  }

  liveChannelNames(): string[] {
    return [...this.channels.keys()].filter((name) => !this.channels.get(name)?.closed);
  }
}

// ── Status and listing ───────────────────────────────────────────────────────

function statusOf(exec: Exec): TaskStatus {
  if (!exec.settled) return "running";
  switch (exec.status) {
    case "ok":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "dead";
  }
}

function taskListing(infos: TaskInfo[]): string[] {
  const rows = infos.map((info) => ({
    code: info.code,
    cells: [
      info.id,
      info.status === "running"
        ? `running (pid ${info.pid})`
        : info.status === "failed" && info.ename
          ? `failed (${info.ename})`
          : info.status,
      formatDuration(info.runtimeSeconds),
      `${info.countsPartial ? ">=" : ""}${info.lines} lines`,
      formatSize(info.bytes),
      info.logExists ? info.logPath : `(no log: ${info.logPath})`,
    ],
  }));
  const widths = rows[0]!.cells.map((_, column) => Math.max(...rows.map((row) => row.cells[column]!.length)));
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(
      row.cells
        .map((cell, column) => (column < row.cells.length - 1 ? cell.padEnd(widths[column]!) : cell))
        .join("  ")
        .trimEnd(),
    );
    if (row.code) lines.push(`  $ ${row.code}`);
  }
  return lines;
}

function taskSection(infos: TaskInfo[]): string[] {
  if (infos.length === 0) return ["", "No background tasks have run in this session."];
  const running = infos.filter((info) => info.status === "running").length;
  const shown = infos.slice(0, LISTING_MAX_TASKS);
  const omitted = infos.length - shown.length;
  return [
    "",
    `Background tasks in this session (${infos.length} tracked, ${running} running):`,
    "",
    ...taskListing(shown),
    ...(omitted > 0 ? ["", `(${omitted} older finished tasks not listed; their logs are in ${EXEC_LOG_DIR})`] : []),
  ];
}

// ── Small helpers ────────────────────────────────────────────────────────────

export function resolveTimeout(timeout: number | undefined): number {
  if (timeout === undefined) return DEFAULT_TIMEOUT_SEC;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0 || timeout > MAX_TIMEOUT_SEC) {
    throw new Error(`invalid timeout: use a finite number of seconds between 0 and ${MAX_TIMEOUT_SEC}`);
  }
  return timeout;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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

function appendLine(path: string, line: string): void {
  const fd = openSync(path, "a");
  try {
    writeFileSync(fd, line, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Keep a channel's history file inside its budget: the newest records, still valid JSONL.
 *
 * Exported because it is the only place in the manager that rewrites a file the user can see, and
 * reaching it through `run` would mean running a few hundred cells.
 */
export function rotateHistory(path: string, maxBytes = HISTORY_ROTATE_BYTES, maxLines = HISTORY_MAX_LINES): boolean {
  if (statSync(path).size <= maxBytes) return false;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim());
  writeFileSync(path, `${lines.slice(-maxLines).join("\n")}\n`, "utf8");
  return true;
}

/**
 * Close a record that was cut off by a crash.
 *
 * An append that never finished leaves the file without its trailing newline, and the next record
 * would be glued onto the torn one, making the newest entry unreadable too.
 */
function sealHistoryTail(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size === 0) return;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r+");
    const last = Buffer.alloc(1);
    if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) writeSync(fd, Buffer.from("\n"), 0, 1, size);
  } catch {
    // Read-only or vanished; the append will fail too and the caller swallows it.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already gone.
      }
    }
  }
}

/** Line and character counts of a log, scanned in bounded chunks. */
function countOutput(path: string): { bytes: number; lines: number; chars: number; partial: boolean } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { bytes: 0, lines: 0, chars: 0, partial: false };
  }
  if (size === 0) return { bytes: 0, lines: 0, chars: 0, partial: false };

  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const decoder = new StringDecoder("utf8");
    let scanned = 0;
    let lines = 0;
    let chars = 0;
    let endsWithNewline = false;
    const cap = 16 * 1024 * 1024;

    while (scanned < size && scanned < cap) {
      const want = Math.min(buffer.length, size - scanned, cap - scanned);
      const bytesRead = readSync(fd, buffer, 0, want, scanned);
      if (bytesRead === 0) break;
      chars += decoder.write(buffer.subarray(0, bytesRead)).length;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0x0a) lines++;
      }
      endsWithNewline = buffer[bytesRead - 1] === 0x0a;
      scanned += bytesRead;
    }
    chars += decoder.end().length;
    if (!endsWithNewline) lines++;
    return { bytes: size, lines, chars, partial: scanned < size };
  } catch {
    return { bytes: size, lines: 0, chars: 0, partial: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
