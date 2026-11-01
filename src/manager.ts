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
import {
  type Channel,
  ChannelBusyError,
  ChannelStartAbortedError,
  type Exec,
  type ExecOutcome,
  type ReadyFrame,
  readLog,
  startChannel,
} from "./channel.ts";
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
/** An exception's *name* is cell-chosen too (`type("x" * 3000, (Exception,), {})`), so it is quoted short. */
const ENAME_CHARS = 200;
/** A channel name is quoted in results, in the history file, and in every later session's prompt. */
const MAX_CHANNEL_NAME_CHARS = 200;
/**
 * What the notes quoting a cell's own names may cost. A Python identifier can be 4095 characters, and
 * the names a cell bound are pasted into the result, into the history file, and from there into the
 * prompt of every later session — so each copy has to be bounded where it is quoted (R3-01).
 */
const DEFINITION_NOTE_MAX = 25;
const DEFINITION_NOTE_NAME_CHARS = 60;
const HISTORY_DEFINITIONS_MAX = 20;
const HISTORY_NAME_CHARS = 120;
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
  /** Records after the one reported that this program cannot use — a torn append, or a record with no
   *  usable channel name in it. */
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
  /** Tasks their channel's closure removed, with the reason: see `bgStop`'s unknown-id answer. */
  private readonly droppedTasks = new Map<string, { channel: string; logPath: string; why: string }>();

  private readonly starting = new Map<string, Promise<Channel>>();
  /**
   * Daemons that have spawned but not answered `ready` yet. They are in no map a shutdown reads, so a
   * session that ends while one is coming up would leave it running forever (F4-01).
   */
  private readonly halfStarted = new Set<Channel>();
  /**
   * Bumped by every `quit()`. A start that began before a quit and finished during it is closed rather
   * than adopted; a start that begins afterwards belongs to the next session and is adopted normally.
   */
  private quitEpoch = 0;
  private readonly listeners = new Set<(exec: Exec) => void>();
  /** Read per channel creation, so the cap can be changed without rebuilding the manager. */
  private get maxChannels(): number {
    return this.maxChannelsSetting().value;
  }

  /**
   * The cap, and which setting it came from. The refusal is the only place the cap is ever *named*, and
   * it must not credit a number to a value it threw away: `PI_REPLMODE_MAX_CHANNELS=0` falls back to the
   * default, and saying "the cap (4, set with PI_REPLMODE_MAX_CHANNELS)" there tells the model the
   * variable asked for 4 (R4-05).
   */
  private maxChannelsSetting(): { value: number; source: string } {
    const raw = process.env.PI_REPLMODE_MAX_CHANNELS?.trim();
    if (!raw) return { value: DEFAULT_MAX_CHANNELS, source: "the default" };
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
      return { value: DEFAULT_MAX_CHANNELS, source: `the default, because PI_REPLMODE_MAX_CHANNELS=${raw} is not a usable cap` };
    }
    return { value, source: "set with PI_REPLMODE_MAX_CHANNELS" };
  }

  // ── Channels ───────────────────────────────────────────────────────────────

  private async getChannel(
    name: string,
    cwd: string,
    onProgress: (message: string) => void,
    signal: AbortSignal | undefined,
  ): Promise<Channel> {
    const existing = this.channels.get(name);
    // `closed` only becomes true once node has been told the process is gone, which can lag the death by
    // an event-loop turn or longer. A call that lands in that window would be handed a daemon that cannot
    // answer: its cell goes to a dead pipe and the call comes back blaming a death the model cannot act
    // on. The process table knows (F4-02, same probe as R4-04's settled answer).
    if (existing && !existing.closed && !processGone(existing.pid)) return existing;
    if (existing) this.channels.delete(name);

    const pending = this.starting.get(name);
    if (pending) return pending;

    const starting = this.createChannel(name, cwd, onProgress, signal);
    this.starting.set(name, starting);
    // The slot comes back the moment the caller cancels, not when that call's rejection has worked its
    // way back through the await chain: the next `run` can ask for the cap in between, and a slot held
    // by a call that has already been cancelled is what R4-06 is about. `release` is guarded by identity
    // so it can never drop somebody else's creation.
    const release = (): void => {
      if (this.starting.get(name) === starting) this.starting.delete(name);
    };
    signal?.addEventListener("abort", release, { once: true });
    try {
      return await starting;
    } finally {
      // The listener goes away with the wait: one signal can be handed to many calls in a session, and a
      // listener that outlives each of them is a leak measured in channels.
      signal?.removeEventListener("abort", release);
      release();
    }
  }

  private async createChannel(
    name: string,
    cwd: string,
    onProgress: (message: string) => void,
    signal: AbortSignal | undefined,
  ): Promise<Channel> {
    // The session this call belongs to is the one that made it, so the epoch is taken on entry: a start
    // that spends seconds inside `makeRoom` — retiring a daemon that will not answer `shutdown` takes as
    // long as that daemon takes to die — would otherwise be measured against the session that begins
    // *after* a quit, and would adopt its daemon into the map the quit just cleared and send its cell to
    // a caller that has gone (R5-02, one position away from F4-01's guard).
    const epoch = this.quitEpoch;
    await this.makeRoom();
    // A call its user cancelled stops here, before a daemon exists, rather than after: the slot is
    // released with the creation, so an aborted start cannot hold one for the whole ready timeout
    // (R4-06). Abandoning the wait for the environment costs nothing — the build is single-flight and
    // carries on in the background for whoever asks next.
    const env = await untilAborted(ensureEnv(onProgress), signal, name);
    let spawned: Channel | undefined;
    let channel: Channel;
    try {
      channel = await startChannel({
        name,
        cwd,
        env,
        signal,
        onSpawned: (daemon) => {
          spawned = daemon;
          // A daemon spawned after this session's quit began is closed on sight: it is not in the set the
          // quit is walking (F4-01).
          if (epoch === this.quitEpoch) this.halfStarted.add(daemon);
          else void daemon.close();
        },
      });
    } catch (error) {
      // A quit that took this channel's daemon on the way out deserves its own sentence, not a death
      // note for a process the host itself stopped (F4-01).
      if (epoch !== this.quitEpoch) throw new Error("the session ended while this channel was starting");
      throw error;
    } finally {
      // `halfStarted` is only ever the set of daemons that are *still* starting: whichever way this call
      // ends, the daemon is either adopted, closed by the start path, or closed here.
      if (spawned) this.halfStarted.delete(spawned);
    }
    if (epoch !== this.quitEpoch) {
      // The session this call belonged to ended while the daemon was coming up: it has nobody left to
      // talk to it, and the next session will start its own.
      void channel.close();
      throw new Error("the session ended while this channel was starting");
    }
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
    if (idlest) {
      await this.shutdownChannel(idlest.name, "retired to make room for a new channel");
      return;
    }
    throw this.capacityRefusal(live);
  }

  /**
   * Why a new channel cannot be given a slot, in terms of what the model can do about it.
   *
   * The two refusals are different problems wearing the same sentence. With nothing running yet, the
   * slots are held by daemons that have not reported `ready`, and there is no task for `bg_stop` to
   * take — waiting is the only move. Saying "all N channels are busy" there points the model at a tool
   * call that cannot work (R3-04).
   */
  private capacityRefusal(live: Channel[]): ChannelCapacityError {
    const cap = this.maxChannelsSetting();
    const limit = `the cap (${cap.value}, ${cap.source}) is reached`;
    const starting = [...this.starting.keys()];
    const names = (list: string[]): string => list.map((name) => `"${name}"`).join(", ");

    if (live.length === 0 && starting.length > 0) {
      return new ChannelCapacityError(
        `channel ${names(starting)} ${starting.length === 1 ? "is" : "are"} still starting and ${limit}: nothing is running yet, so there is no ` +
          "task to stop and no idle channel to retire — wait for the call that is starting to finish, or cancel it, and try again then",
      );
    }
    const alsoStarting = starting.length > 0 ? `; ${names(starting)} ${starting.length === 1 ? "is" : "are"} also still starting` : "";
    return new ChannelCapacityError(
      `all ${cap.value} pi-replmode channels are busy and ${limit}: ` +
        `let a background task finish, stop one with bg_stop, or free a channel with bg_stop {kill: true}${alsoStarting}`,
    );
  }

  /** Close a channel and everything it started. Its variables go with it. */
  async shutdownChannel(name: string, why = "closed"): Promise<boolean> {
    const channel = this.channels.get(name);
    if (!channel) return false;
    this.channels.delete(name);
    await channel.close();
    for (const [id, exec] of [...this.tasks]) {
      if (exec.channelName !== name) continue;
      this.tasks.delete(id);
      // Remembered so a later `bg_stop` for one of these ids can say what took it, instead of blaming
      // the retention window for a deletion the model itself asked for seconds ago (R4-09).
      this.droppedTasks.set(id, { channel: name, logPath: exec.logPath, why });
      if (this.droppedTasks.size > TASK_REGISTRY_LIMIT) {
        const oldest = this.droppedTasks.keys().next().value;
        if (oldest !== undefined) this.droppedTasks.delete(oldest);
      }
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
    if (channelName.length > MAX_CHANNEL_NAME_CHARS) {
      // One long name here is not just one long answer: it goes into the channel's history file and from
      // there into the prompt section of every later session, where it is paid for on every request.
      // The wording has to state the boundary the code enforces — a name of exactly the limit is
      // accepted, so "keep it under 200" forbids a call the tool would have made (R4-07).
      throw new Error(
        `invalid channel name: ${channelName.length} characters, and a name is ${MAX_CHANNEL_NAME_CHARS} at most — it names a channel, a log file and an IPython profile.`,
      );
    }

    let channel: Channel;
    try {
      channel = await this.getChannel(channelName, cwd, onProgress, signal);
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      // A capacity refusal is not a channel that failed to start — nothing was started, and every
      // other channel in the session is running. Say which of the two the model is being told.
      const refused = error instanceof ChannelCapacityError;
      if (!refused && signal?.aborted) {
        // The call was cancelled while its channel was coming up: no cell was sent, and the slot is
        // free again. Saying so is the honest answer, and it is not a channel that failed (R4-06).
        return this.abortedResult(
          channelName,
          `call aborted while channel "${channelName}" was still starting: nothing was sent to it, and the slot its daemon held is free again`,
        );
      }
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

  /** A call its user cancelled before any cell went on the wire (R4-06). */
  private abortedResult(channelName: string, text: string): ReplResult {
    return {
      content: [{ type: "text", text }],
      details: { channel: channelName, status: "dead" },
      structuredContent: { status: "dead", channel: channelName, aborted: true, error: text },
      isError: true,
    };
  }

  private async runLocked(
    channel: Channel,
    code: string,
    timeoutSec: number,
    signal: AbortSignal | undefined,
    onUpdate?: (partial: ReplResult) => void,
  ): Promise<ReplResult> {
    // Same rule one step later: a call that was cancelled while it queued behind another call on this
    // channel does not get to send its cell anyway. A cell has side effects from its first line, and
    // the user has already pressed Esc (R4-06).
    if (signal?.aborted) {
      return this.abortedResult(
        channel.name,
        `call aborted before it reached channel "${channel.name}": nothing was sent, so nothing ran and the channel kept its state`,
      );
    }
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
      // The full traceback goes into the log first, because it is not capture and the shortened copy in
      // the result has to point at something that still holds it (R2-02).
      if (traceback.truncated) exec.appendNote(`\n[full traceback for this cell]\n${tracebackRaw}\n`);
      // Then the numbers are taken from the file the notes point at, after that append: the traceback is
      // the one truncation that changes the log's size, and quoting the totals measured beforehand
      // understates the file the model is sent to (R3-09). `countOutput` stops counting in very large
      // logs, so say when the total is a floor.
      const file = countOutput(exec.logPath);
      const atLeast = file.partial ? "at least " : "";
      const totalChars = Math.max(file.chars, cut.totalChars);
      const totalLines = Math.max(file.lines, cut.totalLines);
      if (cut.truncated) {
        notes.push(
          `output truncated: showing ${cut.headChars} of ${atLeast}${totalChars} characters at the start and ${cut.tailChars} at the end ` +
            `(${cut.shownLines} of ${atLeast}${totalLines} lines)`,
        );
      }
      if (traceback.truncated) {
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
    if (frame?.definitions?.length) notes.push(`defined by this cell: ${definitionList(frame.definitions)}`);
    if (notes.length > 0) blocks.push(notes.map((note) => `[${note}]`).join("\n"));

    const failed = status === "failed" || status === "interrupted" || status === "dead";
    const kept = cut.truncated || traceback.truncated || read.windowed || exec.backgrounded;
    const evalue = frame?.evalue ? oneLine(frame.evalue, EVALUE_CHARS) : null;
    const ename = frame?.ename ? oneLine(frame.ename, ENAME_CHARS) : null;

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
        ...(frame?.ename ? { ename, evalue } : {}),
      },
      structuredContent: {
        status,
        channel: exec.channelName,
        output: cut.text.slice(0, 1_048_576),
        truncated: cut.truncated || traceback.truncated,
        ...(kept ? { full_output_path: exec.logPath } : {}),
        ...(varName ? { variable: varName } : {}),
        elapsed_seconds: round(exec.elapsed),
        ...(frame?.ename ? { error: { ename: ename ?? "", evalue: evalue ?? "" } } : {}),
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
      ...(notes.length > 0
        ? [`daemon said:\n${notes.join("\n")}\n[each line is shortened; the daemon's own log is ${exec.channel.daemonLogPath}]`]
        : []),
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
          ename: exec.frame?.ename ? oneLine(exec.frame.ename, ENAME_CHARS) : null,
          evalue: exec.frame?.evalue ? oneLine(exec.frame.evalue, EVALUE_CHARS) : null,
        };
      });
  }

  async bgStop(taskId: string, reason: string | undefined, kill: boolean): Promise<ReplResult> {
    const exec = this.findExec(taskId);
    if (!exec) {
      const dropped = this.droppedTasks.get(taskId);
      if (dropped) {
        // This id did not age out of the registry: closing the channel it ran on — which the model asked
        // for, or which the cap did on its behalf — removed it seconds ago. Saying "pruned after 3 days"
        // blames a retention window that had nothing to do with it, and leaves the cell's output
        // unfindable (R4-09).
        throw new Error(
          `unknown task: ${taskId}. Its channel "${dropped.channel}" was ${dropped.why}, which removed that channel's tasks from this session. ` +
            `The cell's output is in ${dropped.logPath}, and the channel's variables went with it.`,
        );
      }
      throw new Error(
        `unknown task: ${taskId}. The ID comes from a run that moved to the background; tasks are tracked per pi process and pruned after ${Math.round(RETENTION_MS / 86_400_000)} days.`,
      );
    }

    if (kill) {
      // The escalation: nothing less reaches a cell that ignores SIGINT, and it costs the channel.
      const alive = !exec.channel.closed;
      await this.shutdownChannel(exec.channelName, "killed with bg_stop {kill: true}");
      return {
        content: [
          {
            type: "text",
            text:
              `channel "${exec.channelName}" killed${reason ? ` (${reason})` : ""}. The cell was stopped by taking the whole channel down, ` +
              `so its variables are gone.${alive ? "" : " (the channel was already gone)"}` +
              // The kill is the last thing the model will be told about this cell: closing the channel
              // takes the task out of the listing, so the answer has to carry the log the way a plain
              // stop does (R4-09).
              `\nLog: ${exec.logPath}`,
          },
        ],
        details: { channel: exec.channelName, id: taskId, status: "dead", logPath: exec.logPath },
        structuredContent: { status: "dead", task_id: taskId, channel: exec.channelName, killed: true },
      };
    }

    if (exec.settled) {
      // The cell really did finish, and the status says so. But a channel that went *after* it finished
      // is exactly the case where a model reaches for a variable that is no longer there, so the settled
      // branch reads the death note too (R4-04) — the branch R3-05's fix never walked into.
      return {
        content: [
          {
            type: "text",
            text:
              `task ${taskId} already finished (${statusOf(exec)})${reason ? `; stop requested: ${reason}` : ""}` +
              this.channelGoneNote(exec) +
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

    return this.stoppedResult(exec, taskId);
  }

  /**
   * What a completed `bg_stop` says.
   *
   * `bg_stop`'s promise is that the cell dies and the channel keeps its variables. When the interrupt is
   * what took the daemon down — a SIGINT handler that exits, a C library that dies on the signal — the
   * death note the channel left behind has to be in the answer, or "stopped (dead)" reads as an ordinary
   * stop of an ordinary task and the model reaches for variables that are already gone (R3-05).
   */
  private stoppedResult(exec: Exec, taskId: string): ReplResult {
    const status = statusOf(exec);
    return {
      content: [{ type: "text", text: `task ${taskId} stopped (${status}).${this.channelGoneNote(exec)}\nLog: ${exec.logPath}` }],
      details: { channel: exec.channelName, id: taskId, status, logPath: exec.logPath },
      structuredContent: { status, task_id: taskId, channel: exec.channelName },
    };
  }

  /**
   * The sentence about a channel that went away, for any answer that would otherwise imply the variables
   * in it survived. Empty when the channel is still there, which is the common case and the promise
   * `bg_stop` normally keeps (R3-05, R4-04).
   */
  private channelGoneNote(exec: Exec): string {
    const death = exec.deathNote ?? (exec.channel.closed ? exec.channel.deathNote : undefined);
    if (death) return `\n${death}; the channel is gone and its variables are lost; the next run on it starts a fresh one`;
    // The host only learns about a death from node's exit event, which under load can trail the process
    // being gone by an event-loop turn or more. Asked "can I stop this task?", the honest answer in that
    // window still has to say the channel is not there — and say that the exit status is what is
    // missing, not that it invented one.
    if (processGone(exec.channel.pid)) {
      return (
        `\nthe Python process behind channel "${exec.channelName}" has stopped (its exit status had not reached the host when this was answered)` +
        "; the channel is gone and its variables are lost; the next run on it starts a fresh one"
      );
    }
    return "";
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
   * channel as lost (R2-04) — so a record with no usable name in it is passed over rather than keyed by
   * the stem of the file it happens to be in (R4-02).
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
      try {
        const lines = readFileSync(join(HISTORY_DIR, entry), "utf8")
          .split("\n")
          .filter((line) => line.trim());
        // A crash mid-append leaves a torn record at the end. Reading only the last line would drop
        // the channel from the note entirely; the newest record that parses still says what it held.
        let unusable = 0;
        for (let index = lines.length - 1; index >= 0; index--) {
          try {
            const parsed = JSON.parse(lines[index]!) as HistoryRecord;
            if (!parsed || typeof parsed !== "object") throw new Error("not a record");
            // A record whose `channel` field is missing or empty cannot be attributed to a channel, and
            // the file's stem is not one: it is a digest of a name, and keying the note by it both
            // misses the live channel the note is about and invents a third channel that `run` would
            // happily create if the model typed the stem back (R4-02, and R3-03's fixed-point rule).
            // So keep looking further back in the same file rather than inventing a name.
            const name = typeof parsed.channel === "string" && parsed.channel ? parsed.channel : "";
            if (!name) {
              unusable++;
              continue;
            }
            const record: HistoryRecord = {
              ...parsed,
              channel: name,
              ts: typeof parsed.ts === "string" ? parsed.ts : "",
              ...(unusable > 0 ? { torn: unusable } : {}),
            };
            // One channel can be remembered by more than one file — `a_b.jsonl` from before names got
            // digests and `a_b-<digest>.jsonl` after — and `readdirSync` order would then decide which
            // cell the model is told about. Keep the newest record by its own timestamp (R3-08).
            const known = latest.get(record.channel);
            if (!known || known.ts <= record.ts) latest.set(record.channel, record);
            break;
          } catch {
            unusable++;
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
      ...(exec.frame?.definitions?.length ? { definitions: definitionNames(exec.frame.definitions) } : {}),
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
    // `starting` holds promises, which nothing can close; `halfStarted` holds the daemons those calls
    // spawned, and those can (F4-01). A half-started channel is closed with the same one-shot `close`
    // the start path uses, so whichever of the two gets there first is the one that acts.
    ++this.quitEpoch;
    const channels = [...this.channels.values(), ...this.halfStarted];
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

/**
 * Await `work`, but stop waiting as soon as the call is cancelled. The work itself is not stopped — it
 * is either a shared environment build, which is worth finishing for the next caller, or the daemon
 * spawn, which `startChannel` closes on its own. What this returns is a creation that releases its slot
 * promptly instead of holding one for a call nobody is waiting for (R4-06).
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined, channel: string): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new ChannelStartAbortedError(channel));
  return new Promise<T>((resolve, reject) => {
    const watch = abortWatch(signal);
    work.then(
      (value) => {
        watch.off();
        resolve(value);
      },
      (error) => {
        watch.off();
        reject(error);
      },
    );
    void watch.promise.then(() => reject(new ChannelStartAbortedError(channel)));
  });
}

/**
 * The names a cell bound, quoted for a model: each one shortened to something a human recognises, and
 * the ones that did not fit counted rather than pasted (R3-01).
 */
function definitionList(names: string[]): string {
  const shown = names.slice(0, DEFINITION_NOTE_MAX).map((name) => oneLine(name, DEFINITION_NOTE_NAME_CHARS));
  const more = names.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` (…and ${more} more)` : ""}`;
}

/** The names worth keeping, clipped and capped: the same list goes into the history file (R3-01). */
function definitionNames(names: string[]): string[] {
  return names.slice(0, HISTORY_DEFINITIONS_MAX).map((name) => oneLine(name, HISTORY_NAME_CHARS));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Has this process stopped, as far as something that cannot wait for node's exit event can tell?
 *
 * A child that has died but not yet been reported is a zombie, and `kill(pid, 0)` succeeds on a zombie,
 * so the process-table state is read from `/proc` where that exists. Without `/proc` an unreachable pid
 * counts as gone and a reachable one as running, which is what the answer did before: it lags a death
 * by however long node takes to notice it.
 *
 * Exported because the state it has to read correctly — a zombie is gone, a running process is not — is
 * a window in node's own event loop and cannot be walked into from a tool call.
 */
export function processGone(pid: number): boolean {
  if (pid <= 0) return true;
  let reachable = false;
  try {
    process.kill(pid, 0);
    reachable = true;
  } catch (error) {
    reachable = (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!reachable) return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z";
  } catch {
    return false;
  }
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
