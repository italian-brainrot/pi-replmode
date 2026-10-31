/**
 * The timeout / background / channel-busy contract.
 *
 * The rule the whole suite checks: a timeout or an abort detaches a *call* from a *cell*. Nothing
 * here kills a cell except an interrupt, and nothing kills a channel except an explicit kill — which
 * is why the channel keeps its variables in every case except the one the model asked for.
 */

import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPidAlive, type LoadedExtension, loadExtension, text, waitFor } from "./helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ env: { PI_REPLMODE_MAX_CHANNELS: "12" } });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
});

const run = (code: string, params: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
  ext.callTool("run", { code, ...params }, options);
const bgWait = (timeout?: number) => ext.callTool("bg_wait", timeout === undefined ? {} : { timeout });
const bgStop = (task_id: string, extra: Record<string, unknown> = {}) => ext.callTool("bg_stop", { task_id, ...extra });

describe("moving to the background", () => {
  it("a cell that outlives its timeout keeps running and reports its task", async () => {
    const result = await run("print('starting')\nimport time\nfor i in range(40): time.sleep(0.1)", { channel: "b-timeout", timeout: 1 });
    expect(result.isError).toBeUndefined();
    const shown = text(result);
    expect(shown).toContain("timed out after 1s and moved to background with ID: repl-");
    expect(shown).toContain("starting");
    expect(result.details.status).toBe("running");
    expect(result.details.logPath).toBeTruthy();
    expect(existsSync(result.details.logPath)).toBe(true);

    const waited = await bgWait(20);
    const listing = text(waited);
    expect(listing).toContain(result.details.id);
    expect(listing).toContain("completed");
    expect(listing).toContain("1 tracked, 0 running");
  });

  it("`timeout: 0` starts in the background without waiting", async () => {
    const started = Date.now();
    const result = await run("import time\ntime.sleep(2)", { channel: "b-zero", timeout: 0 });
    expect(Date.now() - started).toBeLessThan(1200);
    expect(result.details.status).toBe("running");
    expect(text(result)).toContain("started in the background with ID:");
    await bgWait(20);
  });

  it("keeps streaming the cell's output to the log while it runs", async () => {
    const result = await run("import time\nfor i in range(30): print('tick', i) or time.sleep(0.05)", { channel: "b-log", timeout: 1 });
    const id = result.details.id;
    await waitFor(
      () => {
        const shown = readFileSync(result.details.logPath, "utf8");
        return shown.includes("tick 29");
      },
      15_000,
      "the background cell to finish writing",
    );
    const waited = await bgWait(20);
    expect(text(waited)).toContain(id);
    expect(text(waited)).toContain("completed");
  });
});

describe("a busy channel", () => {
  it("refuses new work while a background cell runs, and says what to do", async () => {
    const background = await run("import time\ntime.sleep(3)", { channel: "b-busy", timeout: 1 });
    const blocked = await run("print('should not run')", { channel: "b-busy" });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain(`channel "b-busy" is busy`);
    expect(text(blocked)).toContain(background.details.id);
    expect(text(blocked)).toContain("bg_wait");

    await bgWait(20);
    const after = await run("print('now it runs')", { channel: "b-busy" });
    expect(text(after)).toContain("now it runs");
  });

  it("does not block a different channel", async () => {
    const background = await run("import time\ntime.sleep(2)", { channel: "b-other-busy", timeout: 1 });
    const other = await run("print('unaffected')", { channel: "b-free" });
    expect(text(other)).toContain("unaffected");
    await bgWait(20);
    expect(text(await bgStop(background.details.id))).toContain("already finished");
  });

  it("queues two foreground calls on one channel instead of interleaving them", async () => {
    const [a, b] = await Promise.all([
      run("import time\ntime.sleep(0.6)\nprint('first')", { channel: "b-queue", timeout: 20 }),
      run("print('second')", { channel: "b-queue", timeout: 20 }),
    ]);
    expect(text(a)).toContain("first");
    expect(text(b)).toContain("second");
    expect(text(a)).not.toContain("second");
  });
});

describe("bg_wait", () => {
  it("says plainly when there is nothing to wait for", async () => {
    const result = await bgWait(5);
    expect(text(result)).toContain("No background tasks are running.");
  });

  it("returns as soon as any task finishes, and lists every task of the session", async () => {
    const slow = await run("import time\ntime.sleep(3.5)", { channel: "b-wait-slow", timeout: 1 });
    const quick = await run("import time\ntime.sleep(1.5)", { channel: "b-wait-quick", timeout: 1 });
    expect(slow.details.status).toBe("running");
    expect(quick.details.status).toBe("running");
    const started = Date.now();
    const waited = await bgWait(30);
    const elapsed = Date.now() - started;
    // `quick` had about half a second left when the wait began, so the wait ends there rather than
    // with `slow`: bg_wait is a wait for *any* task, not for all of them.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2500);
    const shown = text(waited);
    expect(shown).toContain("finished");
    expect(shown).toContain(quick.details.id);
    expect(shown).toContain(slow.details.id);
    expect(shown).toContain("$ import time");
    expect(shown).toContain("running");
    expect(shown).toContain("lines");
    expect(waited.details.tasks?.length).toBeGreaterThanOrEqual(2);
    await waitFor(async () => (await bgWait(15)).details.running.length === 0, 20_000, "both cells to finish");
  });

  it("honours its own timeout without disturbing the tasks", async () => {
    const long = await run("import time\ntime.sleep(30)", { channel: "b-wait-timeout", timeout: 1 });
    const waited = await bgWait(1);
    expect(text(waited)).toContain("Timeout reached (1s)");
    expect(waited.details.running).toContain(long.details.id);
    expect(text(await bgStop(long.details.id))).toContain("stopped (interrupted)");
  });

  it("reports a background cell that died", async () => {
    const result = await run("import time, os\ntime.sleep(0.5)\nos._exit(9)", { channel: "b-death", timeout: 0 });
    const waited = await bgWait(20);
    expect(text(waited)).toContain(result.details.id);
    expect(text(waited)).toContain("dead");
  });
});

describe("bg_stop", () => {
  it("interrupts a background cell and leaves the channel usable with its state", async () => {
    await run("durable = 'kept'", { channel: "b-stop" });
    const background = await run("import time\nwhile True: time.sleep(0.1)", { channel: "b-stop", timeout: 1 });
    const stopped = await bgStop(background.details.id, { reason: "done with it" });
    expect(text(stopped)).toContain("stopped (interrupted)");
    expect(stopped.details.status).toBe("interrupted");

    const after = await run("print(durable)", { channel: "b-stop" });
    expect(text(after)).toContain("kept");
  });

  it("refuses an unknown id with something to act on", async () => {
    const result = await bgStop("repl-nosuchid");
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("unknown task");
  });

  it("says so when a cell ignores SIGINT, and only kills the channel when told", async () => {
    const stubborn = await run("import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nwhile True: time.sleep(0.1)", {
      channel: "b-stubborn",
      timeout: 1,
    });
    const pid = stubborn.details.pid!;
    const attempted = await bgStop(stubborn.details.id);
    expect(attempted.isError).toBe(true);
    expect(text(attempted)).toContain("did not stop on SIGINT");
    expect(text(attempted)).toContain("kill: true");
    expect(isPidAlive(pid)).toBe(true);

    const killed = await bgStop(stubborn.details.id, { kill: true, reason: "unresponsive" });
    expect(text(killed)).toContain("killed");
    await waitFor(() => !isPidAlive(pid), 10_000, "the channel process to go away");

    const fresh = await run("print('clean slate')", { channel: "b-stubborn" });
    expect(text(fresh)).toContain("[new channel");
    expect(text(fresh)).toContain("clean slate");
  });

  it("stops a cell that never ends on its own and reports the log", async () => {
    const background = await run("import time\ntime.sleep(60)", { channel: "b-stop-log", timeout: 1 });
    const stopped = await bgStop(background.details.id);
    expect(text(stopped)).toContain("Log:");
    expect(existsSync(stopped.details.logPath)).toBe(true);
  });
});
