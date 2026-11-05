/**
 * pi-replmode — a stateful IPython REPL in place of pi's one-shot tools.
 *
 * Three tools and nothing else: `run`, `bg_wait`, `bg_stop`. The extension never calls
 * `setActiveTools()` and never registers anything under a built-in name — dropping pi's built-ins is
 * a setting (`"defaultTools": []`), not something an extension should do to the session.
 *
 * It also never writes a section into the system prompt. What the model needs to know about behaviour is
 * in the tool descriptions and parameter descriptions; what it needs to know about how to work with them
 * is in the `promptGuidelines` those tools register; the one session-dynamic fact goes into pi's own
 * `options.promptGuidelines` list. All three are pi's slots, and pi leaves every one of them out when the
 * user overrides the prompt with `SYSTEM.md` or `--system-prompt` (see `before_agent_start` below).
 */

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ChannelBusyError } from "./channel.ts";
import {
  ChannelNamedError,
  DEFAULT_BG_WAIT_TIMEOUT_SEC,
  getManager,
  type HistoryNote,
  type ReplResult,
  type RunParams,
  resolveTimeout,
  type TaskStatus,
} from "./manager.ts";
import { historyChannelLabel, lostChannelGuidelines } from "./prompt.ts";

/**
 * Behaviour only. How to write Python, how to read a file, and how to structure work in the REPL are not
 * here: the model knows what an IPython REPL is, and spelling the idioms out is a nudge paid for on
 * every request. What has to be stated is what this tool does that a plain REPL does not — that the
 * process is the same one across calls, what happens at the output limit and at the timeout, and what
 * is installed.
 */
const RUN_DESCRIPTION =
  "Execute Python code in a stateful IPython REPL. Every call on a channel runs in the same Python " +
  "process: variables, imports, and functions defined earlier are still there, and a cell that raises " +
  "returns its traceback without losing them. Magics, `!cmd`, and top-level `await` work; a trailing " +
  "expression shows its repr. A cell can reach the machine — files, network, subprocesses — with the " +
  "harness's own permissions. Installed: numpy, pandas, polars, scipy, matplotlib, httpx, Pillow, " +
  "opencv, librosa, scikit-learn, playwright. " +
  "`pi.channel`, `pi.cwd`, `pi.python_version` and `pi.ipython_version` describe the session. Output over " +
  "50000 characters is cut with head and tail kept; the whole text is written to a log file and bound to " +
  "a global in that channel. A cell that runs past `timeout` is not killed: it keeps running in the " +
  "background and its channel stays busy.";

const RUN_PARAMETERS = Type.Object({
  code: Type.String({ description: "Code to send to the REPL. One cell; may be many lines." }),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Seconds before the cell moves to the background (default 60). It is never killed at the timeout: it keeps running and its channel stays busy. 0 starts it in the background immediately.",
    }),
  ),
  channel: Type.Optional(
    Type.String({
      description:
        'Isolated REPL instance (default "main"), created on first use. Separate variables and process per channel. ' +
        // R4-07: this is where a name is chosen, so this is where the rule that makes a call fail has to
        // be — the refusal alone leaves the model to discover it once a session.
        // R5-06: and the reason has to be one the code backs up. File names are not bounded by the name
        // (`channelFileStem` digests anything over 40 characters or with an unsafe character, so every
        // name this tool accepts yields a stem of at most ~51); the name is bounded because it comes
        // back to the model, in results and in every later session's prompt.
        "A name is at most 200 characters: it is quoted back in results, in the history file, and in the prompt of every later session.",
    }),
  ),
});

const RUN_OUTPUT = Type.Object(
  {
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("interrupted"),
      Type.Literal("running"),
      Type.Literal("dead"),
    ]),
    channel: Type.String(),
    // Optional because they genuinely do not exist for a call that never reached a daemon: a busy
    // channel, an empty cell, an invalid timeout, and a cell the tool handed to the background have no
    // output, no truncation decision and no elapsed time to report yet. The schema has to describe the
    // answers the tool actually gives — it is what a model reads when it wraps the tool (R2-05).
    output: Type.Optional(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    full_output_path: Type.Optional(Type.String()),
    variable: Type.Optional(Type.String()),
    elapsed_seconds: Type.Optional(Type.Number()),
    error: Type.Optional(Type.Object({ ename: Type.String(), evalue: Type.String() })),
  },
  { additionalProperties: true },
);

const BG_WAIT_PARAMETERS = Type.Object({
  timeout: Type.Optional(Type.Number({ description: `Seconds to wait for any task to finish (default ${DEFAULT_BG_WAIT_TIMEOUT_SEC})` })),
});
const BG_STOP_PARAMETERS = Type.Object({
  task_id: Type.String({ description: "Task ID, from a run that moved to the background" }),
  reason: Type.Optional(Type.String({ description: "Why the task is being stopped" })),
  kill: Type.Optional(
    Type.Boolean({
      description:
        "Take the whole channel down to stop a task that ignores SIGINT. This ends every cell in that channel " +
        "and everything those cells started — servers, builds, subprocesses — except any that moved into a " +
        "process group of their own, which the kill cannot reach. Its variables go with it; only reach for it " +
        "when a plain stop fails.",
    }),
  ),
});

export default function (pi: ExtensionAPI): void {
  const manager = getManager();
  // What this process's earlier sessions left behind, read once per session. `undefined` means this
  // process has not been through a session boundary yet; the list is not re-read mid-session, because
  // pi replays the rules it has already sent and rewriting them costs the prompt cache.
  let lostNotes: HistoryNote[] | undefined;

  pi.registerTool({
    name: "run",
    label: "REPL",
    description: RUN_DESCRIPTION,
    parameters: RUN_PARAMETERS,
    outputSchema: RUN_OUTPUT,
    // Different channels genuinely overlap; the manager serializes calls to the same one.
    executionMode: "parallel",
    promptSnippet: "Run Python in a stateful IPython REPL that keeps its process between calls",
    // Guidelines are pi's own place for what to do with a tool; the description above stays a description
    // of behaviour. Each bullet here is also a fact the model can act on, so it is stated once here and
    // nowhere in the prompt body (there is no prompt section of our own).
    promptGuidelines: [
      "The REPL holds its state between calls, so a dataframe, a connection, or a function defined earlier is still there; do not re-import or re-compute it.",
      "A cell that outlives its `timeout` moves to the background and blocks its channel until it finishes; pass a longer one for work you expect to take that long.",
      "Channels are independent and run concurrently, one cell at a time each; use a separate `channel` for independent long-running work.",
      "Channels are capped: at the cap the idlest one is retired with its variables, and if they are all busy a new channel is refused.",
      "`bg_stop` interrupts one cell and keeps its channel; `bg_stop {kill: true}` takes the channel down and ends the servers, builds and subprocesses its cells started, except any that moved into a process group of their own.",
    ],

    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<ReplResult> {
      const args = params as RunParams;
      const progress = (message: string): void => {
        if (ctx.hasUI) ctx.ui.notify(message, "info");
      };
      try {
        return await manager.run(args, ctx.cwd, signal, progress, onUpdate);
      } catch (error) {
        return failure(error, args.channel ?? "main");
      }
    },
  });

  pi.registerTool({
    name: "bg_wait",
    label: "REPL Background Wait",
    description:
      "Wait for ANY background REPL task of this session to finish, then list every background task with " +
      "its channel, status, run time, output size, and the log file holding its full output. Returns when " +
      `the wait times out (${DEFAULT_BG_WAIT_TIMEOUT_SEC}s by default) with the tasks still running listed.`,
    parameters: BG_WAIT_PARAMETERS,
    executionMode: "parallel",
    promptSnippet: "Wait for any background REPL task to finish and list all of them",
    promptGuidelines: ["bg_wait blocks until one background task finishes and then lists every task, so there is nothing to poll."],

    async execute(_toolCallId, params, signal): Promise<ReplResult> {
      const { timeout } = params as { timeout?: number };
      const timeoutSec = timeout === undefined ? DEFAULT_BG_WAIT_TIMEOUT_SEC : resolveTimeout(timeout);
      try {
        return await manager.bgWait(timeoutSec, signal);
      } catch (error) {
        // No channel to name: a `bg_wait` refusal is about the task registry, not about a channel, and
        // the `"main"` this used to pass became a field claiming one (R6-03).
        return failure(error);
      }
    },
  });

  pi.registerTool({
    name: "bg_stop",
    label: "REPL Background Stop",
    description:
      "Stop a background REPL task: SIGINT to its channel, which ends the cell and leaves the channel and its " +
      "variables intact. A task that ignores SIGINT stays running and the result says so; `kill: true` then " +
      "takes the whole channel down, losing its state.",
    parameters: BG_STOP_PARAMETERS,
    executionMode: "parallel",
    promptSnippet: "Interrupt a background REPL task, or take its whole channel down",

    async execute(_toolCallId, params): Promise<ReplResult> {
      const { task_id: taskId, reason, kill } = params as { task_id: string; reason?: string; kill?: boolean };
      try {
        return await manager.bgStop(taskId, reason, kill === true);
      } catch (error) {
        // The answer's own channel comes from the error when there is one to name (R6-03); `bg_stop` is
        // called with a task id and cannot know a channel in advance.
        return failure(error);
      }
    },
  });

  pi.on("session_start", (event, ctx) => {
    // A new session boundary re-reads what earlier processes left behind. Live channels are this
    // process's own and are not reported as lost.
    manager.pruneRetention();
    lostNotes = manager.lostChannelNotes();
    if (lostNotes.length > 0 && ctx.hasUI) {
      // Quoted through the same bound as the note: this is the other place a remembered name reaches
      // a model, and it reads the same history files (R4-01).
      ctx.ui.notify(
        `pi-replmode: ${lostNotes.length} channel(s) from a previous session are gone (${lostNotes.map((note) => historyChannelLabel(note)).join(", ")}); their variables were lost`,
        "info",
      );
    }
    void event;
  });

  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    if (!options) return undefined;
    // `customPrompt` is what pi sets from a `SYSTEM.md` in the agent dir or the project, or from
    // `--system-prompt`. pi renders no `preamble`, `tools`, or `rules` section then — the tool snippets
    // and guidelines this extension contributes are already gone — so the owner of that prompt asked for
    // their own words, and this extension adds nothing to the prompt at all.
    if (options.customPrompt !== undefined) return undefined;
    if (lostNotes === undefined) lostNotes = manager.lostChannelNotes();
    const bullets = lostChannelGuidelines(lostNotes);
    if (bullets.length === 0) return undefined;
    // pi hands a normalized copy of its own options to every `before_agent_start`, so `promptGuidelines`
    // is already an array; the guard is for a runtime that hands over a bare object.
    if (!Array.isArray(options.promptGuidelines)) options.promptGuidelines = [];
    options.promptGuidelines.push(...bullets);
    return undefined;
  });

  pi.on("session_shutdown", async (event) => {
    await manager.closeAll(event.reason);
  });
}

/** A thrown error becomes a tool error rather than a pi-level crash. */
function failure(error: unknown, channel?: string): ReplResult {
  const text = error instanceof Error ? error.message : String(error);
  // A status from the enum the tool declares, and the same one in both views of the result: a busy
  // channel is `running`, and every other refusal here is a call that never got a live channel. The
  // `"error"` this used to put in `structuredContent` is not a status at all, and contradicted
  // `details.status` in the same object (R2-05).
  const status: TaskStatus = error instanceof ChannelBusyError ? "running" : "dead";
  // An error that knows which channel its own sentence is about says so, and an error that knows it is
  // about no channel at all leaves the field out — the `"main"` this used to fill in for `bg_stop` and
  // `bg_wait` named a channel no part of the answer was about (R6-03).
  const named = error instanceof ChannelNamedError ? error.channel : channel;
  if (named === undefined) {
    return {
      content: [{ type: "text", text }],
      details: { status },
      structuredContent: { status, error: text },
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text }],
    details: { channel: named, status },
    structuredContent: { status, channel: named, error: text },
    isError: true,
  };
}

/** Used by tests: the context type a tool call receives. */
export type { ExtensionToolContext };
