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

describe("what the listing claims about channels", () => {
  it("R6-03: a listing whose tasks span two channels claims no single channel for itself", async () => {
    // `bg_wait` answers about the whole registry, and its rows name a channel each. Its `details.channel`
    // was the first task's channel — and `"main"` when the registry was empty — which is R6-03's mistake
    // in a listing: the structured view of an answer about two channels picks one of them, and a model
    // acting on that field acts on the wrong channel.
    const a = await ext.callTool("run", { code: "import time\ntime.sleep(2)", channel: "w-chan-a", timeout: 0 });
    await ext.callTool("run", { code: "import time\ntime.sleep(2)", channel: "w-chan-b", timeout: 0 });
    const waited = await ext.callTool("bg_wait", { timeout: 20 });
    const shown = text(waited);
    const tasks = (waited.details?.tasks ?? []) as Array<{ id: string; channel: string }>;
    const channels = new Set(tasks.map((task) => task.channel));

    // The case ran: the listing really does span two channels, including the cell that started it.
    expect(channels.has("w-chan-a") && channels.has("w-chan-b"), `the listing does not span two channels: ${shown}`).toBe(true);
    expect(
      tasks.some((task) => task.id === a.details.id),
      `the cell that started this listing is not in it: ${shown}`,
    ).toBe(true);

    expect(
      waited.details?.channel,
      `an answer about two channels names one of them in details: ${JSON.stringify(waited.details?.channel)} — ${shown}`,
    ).toBeUndefined();
    expect(
      waited.structuredContent?.channel,
      `and picks one in structuredContent: ${JSON.stringify(waited.structuredContent?.channel)}`,
    ).toBeUndefined();
    // Nothing was lost by dropping the single one: every row still carries the channel its task ran on.
    expect(
      tasks.every((task) => typeof task.channel === "string" && task.channel.length > 0),
      `a task row names no channel: ${shown}`,
    ).toBe(true);
  });
});
