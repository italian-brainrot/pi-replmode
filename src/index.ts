/**
 * pi-replmode — a stateful IPython REPL in place of pi's one-shot tools.
 *
 * Three tools and nothing else: `run`, `bg_wait`, `bg_stop`. The extension never calls
 * `setActiveTools()` and never registers anything under a built-in name — dropping pi's built-ins is
 * a setting (`"defaultTools": []`), not something an extension should do to the session.
 */

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ChannelBusyError } from "./channel.ts";
import { DEFAULT_BG_WAIT_TIMEOUT_SEC, getManager, type ReplResult, type RunParams, resolveTimeout, type TaskStatus } from "./manager.ts";
import { renderSection, SECTION_NAME } from "./prompt.ts";

const RUN_DESCRIPTION =
  "Execute Python code in a stateful IPython REPL. This is how you read, edit, and write files and run " +
  "commands: full Python plus a shell (`open(path).read()`, `!cmd`, `subprocess`), with numpy, pandas, " +
  "polars, scipy, matplotlib, httpx, Pillow, opencv, librosa, scikit-learn and playwright installed. " +
  "Variables, imports, and functions persist between calls, so define the tool you want as a function and " +
  "reuse it. Magics and top-level await work; a trailing expression's repr is shown. " +
  "Output over 50000 characters is truncated and the full text is kept in a log file and bound to a global. " +
  "A cell that runs past `timeout` keeps running in the background (bg_wait, bg_stop).";

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
      description: 'Isolated REPL instance (default "main"), created on first use. Separate variables and process per channel.',
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
  let section: string | undefined;

  pi.registerTool({
    name: "run",
    label: "REPL",
    description: RUN_DESCRIPTION,
    parameters: RUN_PARAMETERS,
    outputSchema: RUN_OUTPUT,
    // Different channels genuinely overlap; the manager serializes calls to the same one.
    executionMode: "parallel",
    promptSnippet: "Execute code in a stateful IPython REPL (files, commands, Python, shell)",
    promptGuidelines: [
      "Do the work in the REPL: it holds state, so a dataframe, a parsed tree, a connection, or a function you wrote stays available for the next call.",
      "Do not re-import or re-compute what the channel already has; check with `dir()` or `%who_ls` when unsure.",
      "Pass a longer `timeout` only for work you expect to take that long; a cell that outlives its timeout moves to the background and blocks its channel.",
      "Use separate channels for independent long-running work; one channel runs one cell at a time.",
      "Channels are capped: at the cap the idlest one is retired with its variables, and if they are all busy a new channel is refused. Keep the count to what you need.",
      "`bg_stop` interrupts one cell and keeps its channel; `bg_stop {kill: true}` takes the channel down and ends the processes its cells started, except any that moved into a process group of their own.",
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
      "Wait for ANY background REPL task to finish (like `wait -n`), then list every background task of this " +
      "session with its channel, status, run time, output size, and log path. Has a timeout (default 1 hour).",
    parameters: BG_WAIT_PARAMETERS,
    executionMode: "parallel",
    promptGuidelines: [
      "After a cell moves to the background, do not poll for it — bg_wait blocks until something finishes and then lists every task.",
      "A task's log path holds its full output; read it from the REPL with `open(path).read()` if you need it.",
    ],

    async execute(_toolCallId, params, signal): Promise<ReplResult> {
      const { timeout } = params as { timeout?: number };
      const timeoutSec = timeout === undefined ? DEFAULT_BG_WAIT_TIMEOUT_SEC : resolveTimeout(timeout);
      try {
        return await manager.bgWait(timeoutSec, signal);
      } catch (error) {
        return failure(error, "main");
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

    async execute(_toolCallId, params): Promise<ReplResult> {
      const { task_id: taskId, reason, kill } = params as { task_id: string; reason?: string; kill?: boolean };
      try {
        return await manager.bgStop(taskId, reason, kill === true);
      } catch (error) {
        return failure(error, "main");
      }
    },
  });

  pi.on("session_start", (event, ctx) => {
    // A new session boundary re-reads what earlier processes left behind. Live channels are this
    // process's own and are not reported as lost.
    manager.pruneRetention();
    section = renderSection(manager.lostChannelNotes());
    const notes = manager.lostChannelNotes();
    if (notes.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `pi-replmode: ${notes.length} channel(s) from a previous session are gone (${notes.map((note) => note.channel).join(", ")}); their variables were lost`,
        "info",
      );
    }
    void event;
  });

  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    if (!options) return undefined;
    if (section === undefined) {
      // A session that has not started (or has nothing to say) still gets the stable part.
      section = renderSection(manager.lostChannelNotes());
    }
    if (!options.sections || typeof options.sections !== "object") options.sections = {};
    options.sections[SECTION_NAME] = section;
    return undefined;
  });

  pi.on("session_shutdown", async (event) => {
    await manager.closeAll(event.reason);
  });
}

/** A thrown error becomes a tool error rather than a pi-level crash. */
function failure(error: unknown, channel: string): ReplResult {
  const text = error instanceof Error ? error.message : String(error);
  // A status from the enum the tool declares, and the same one in both views of the result: a busy
  // channel is `running`, and every other refusal here is a call that never got a live channel. The
  // `"error"` this used to put in `structuredContent` is not a status at all, and contradicted
  // `details.status` in the same object (R2-05).
  const status: TaskStatus = error instanceof ChannelBusyError ? "running" : "dead";
  return {
    content: [{ type: "text", text }],
    details: { channel, status },
    structuredContent: { status, channel, error: text },
    isError: true,
  };
}

/** Used by tests: the context type a tool call receives. */
export type { ExtensionToolContext };
