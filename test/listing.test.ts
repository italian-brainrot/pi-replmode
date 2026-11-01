/**
 * What `bg_wait` says about the session's tasks, rather than about one task.
 *
 * This file exists on its own because the case it holds needs a session whose task registry is empty
 * except for the task under test — and the registry belongs to the process-wide manager, of which
 * vitest gives one per file (`isolate: true`). Any other file would have already backgrounded cells
 * of its own, and their rows would hide the sentence being tested.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, text } from "./helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ env: { PI_REPLMODE_MAX_CHANNELS: "12" } });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
});

describe("the task listing after its channel went", () => {
  it("R5-07: a wait that ends because a kill took the task does not then deny the task ran", async () => {
    // R4-09 left the listing half-done on purpose: closing a channel removes its tasks, so `bg_wait`
    // cannot show killed work. In one reachable case that half-measure leaves something worse than an
    // omission: `bg_wait` writes its summary from the execs it was watching and its listing from the
    // registry, and a `bg_stop { kill: true }` issued by another call empties the registry between the
    // two. So a single answer reads "1 task(s) finished: repl-…" and, three lines later, "No background
    // tasks have run in this session." Measured at HEAD: exactly that pair, in one result.
    const task = await ext.callTool("run", { code: "import time\ntime.sleep(30)", channel: "w-waitkill", timeout: 0 });
    const waiting = ext.callTool("bg_wait", { timeout: 20 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await ext.callTool("bg_stop", { task_id: task.details.id, kill: true });
    const shown = text(await waiting);

    const deniesItEverRan = shown.includes("No background tasks have run in this session.");
    const namesTheFinishedTask = shown.includes(task.details.id);
    expect(deniesItEverRan && namesTheFinishedTask, `one answer reports a finished task and denies any task has run: ${shown}`).toBe(false);
  });
});
