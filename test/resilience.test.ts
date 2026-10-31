/**
 * Interrupt and lifecycle under real pressure.
 *
 * The design's two rules are that a timeout never kills a cell and that SIGINT is the way a cell
 * dies. These tests hold the host to the other half of that: an interrupt has to reach a cell that
 * is *waiting* rather than spinning, a killed channel has to stop what its cell started, and a
 * channel that dies underneath a call has to be reported as dead instead of quietly replaced.
 *
 * Tests whose comment names an issue id (R1-nn) document a defect from the pass-1 audit and are
 * expected to fail until it is fixed.
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

describe("interrupting a cell that is waiting", () => {
  it("R1-01: an aborted call stops a cell that is sitting in a top-level await", async () => {
    // The daemon owns the event loop the cell awaits on. A SIGINT that lands while the cell is
    // suspended is caught by the daemon's loop and dropped: the cell keeps waiting, the channel
    // stays busy, and the tool says the cell "did not stop after an interrupt".
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1200);
    const result = await run(
      "kept = 'still here'\nimport asyncio\nawait asyncio.sleep(20)\nprint('finished the await')",
      { channel: "r-await", timeout: 40 },
      { signal: controller.signal },
    );

    expect(result.isError).toBe(true);
    expect(result.details.status, "the await ignored the interrupt").toBe("interrupted");
    expect(text(result)).toContain("interrupted");

    const after = await run("print(kept)", { channel: "r-await" });
    expect(text(after), "the channel is still busy with a cell that was never stopped").toContain("still here");
  });

  it("stops a cell that is waiting on a subprocess it started", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1200);
    const result = await run(
      "import subprocess\nsubprocess.run(['sleep', '20'])\nprint('done')",
      { channel: "r-sub", timeout: 40 },
      { signal: controller.signal },
    );
    expect(result.details.status).toBe("interrupted");
    const after = await run("print('channel free')", { channel: "r-sub" });
    expect(text(after)).toContain("channel free");
  });

  it("leaves the channel usable after a second interrupt arrives on top of the first", async () => {
    const background = await run("import time\nwhile True:\n    time.sleep(0.05)", { channel: "r-stack", timeout: 1 });
    await bgStop(background.details.id);
    await bgStop(background.details.id);
    const after = await run("print('interrupted once, usable still')", { channel: "r-stack" });
    expect(text(after)).toContain("usable still");
  });
});

describe("killing a channel", () => {
  it("R1-10: takes the processes that its cell started down with it", async () => {
    // The escalation the model is offered when a task will not stop: `kill: true` says it ends
    // every cell in the channel. The daemon exits on the shutdown frame, so the group-kill
    // escalation never runs and the cell's children keep running - burning CPU and holding ports
    // after the channel that made them is gone.
    const pidFile = `${ext.agentDir}/orphan-child.pid`;
    const cell = await run(
      `import subprocess\nchild = subprocess.Popen(['bash','-c','sleep 60'], stdin=subprocess.DEVNULL)\nopen(${JSON.stringify(pidFile)},'w').write(str(child.pid))\nprint('spawned')`,
      { channel: "r-killkids", timeout: 0 },
    );
    await waitFor(() => existsSync(pidFile), 15_000, "the cell to record its child's pid");
    const childPid = Number(readFileSync(pidFile, "utf8"));
    expect(isPidAlive(childPid)).toBe(true);

    const killed = await bgStop(cell.details.id, { kill: true, reason: "test" });
    expect(text(killed)).toContain("killed");
    await waitFor(() => !isPidAlive(cell.details.pid!), 10_000, "the channel daemon to go away");
    await waitFor(() => !isPidAlive(childPid), 5_000, "the cell's child to be taken down with the channel");
  });

  it("reports a daemon that is killed underneath a foreground cell", async () => {
    const warm = await run("import os", { channel: "r-sigkill" });
    const pid = warm.details.pid!;
    const inFlight = run("import time\nprint('halfway')\ntime.sleep(30)\nprint('never')", { channel: "r-sigkill", timeout: 25 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    process.kill(pid, "SIGKILL");

    const result = await inFlight;
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("dead");
    expect(text(result)).toMatch(/ended|dead/);

    const fresh = await run("print('rebuilt')", { channel: "r-sigkill" });
    expect(text(fresh)).toContain("[new channel");
    expect(text(fresh)).toContain("rebuilt");
  });

  it("marks a backgrounded task dead when its channel is killed", async () => {
    const cell = await run("import time\ntime.sleep(30)", { channel: "r-sigkill-bg", timeout: 0 });
    process.kill(cell.details.pid!, "SIGKILL");
    const waited = await bgWait(20);
    expect(text(waited)).toContain(cell.details.id);
    const tasks: { id: string; status: string }[] = waited.details.tasks ?? [];
    expect(tasks.find((task) => task.id === cell.details.id)?.status).toBe("dead");
  });

  it("R1-10: takes the same processes down at session shutdown, not only on an explicit kill", async () => {
    // `PI_REPLMODE_KEEP_RUNNING=0` and a quit are documented to leave nothing running behind.
    const pidFile = `${ext.agentDir}/quit-child.pid`;
    await run(
      `import subprocess\nchild = subprocess.Popen(['bash','-c','sleep 60'], stdin=subprocess.DEVNULL)\nopen(${JSON.stringify(pidFile)},'w').write(str(child.pid))\nprint('spawned for the quit path')`,
      { channel: "r-quitkids", timeout: 15 },
    );
    await waitFor(() => existsSync(pidFile), 15_000, "the cell to record its child's pid");
    const childPid = Number(readFileSync(pidFile, "utf8"));
    expect(isPidAlive(childPid)).toBe(true);

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    await waitFor(() => !isPidAlive(childPid), 10_000, "the cell's child to die with the session");
  });
});
