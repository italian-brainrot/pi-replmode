/**
 * Reload and session replacement.
 *
 * pi clears its extension module cache on `/reload` and re-runs the factories, but the Node process
 * — and the pipes to every channel daemon — stay. A manager rebuilt from scratch would leave those
 * daemons running with nobody able to see, wait for, or stop them, so the manager is kept on
 * `globalThis` and every runtime in the process shares it.
 */

import { describe, expect, it, vi } from "vitest";
import { isPidAlive, loadExtension, makeTempDir, text, waitFor } from "./helpers/extension.ts";

describe("reload", () => {
  it("re-adopts the daemons of the previous runtime instead of orphaning them", async () => {
    const agent = makeTempDir("replmode-agent-");
    const env = { PI_REPLMODE_MAX_CHANNELS: "12" };

    const first = await loadExtension({ agentDir: agent.path, env });
    const started = await first.callTool("run", { code: "remembered = 'kept'\nprint('first runtime')", channel: "x-adopt" });
    const pid = started.details.pid;
    expect(text(started)).toContain("[new channel");

    // What `/reload` does: the old runtime is torn down, the module cache is cleared, and a new
    // factory runs against the same process.
    await first.emit({ type: "session_shutdown", reason: "reload" });
    first.dispose();
    vi.resetModules();

    const second = await loadExtension({ agentDir: agent.path, env });
    expect(isPidAlive(pid)).toBe(true);

    const after = await second.callTool("run", { code: "print(remembered)", channel: "x-adopt" });
    expect(text(after)).toContain("kept");
    expect(text(after)).not.toContain("[new channel");
    expect(after.details.pid).toBe(pid);

    // A real quit does take them down.
    await second.emit({ type: "session_shutdown", reason: "quit" });
    await waitFor(() => !isPidAlive(pid), 15_000, "the channel daemon to exit on quit");
    second.dispose();
    agent.dispose();
  });

  it("carries background tasks over to the new runtime, where they can still be waited for and stopped", async () => {
    // A cell that had already moved to the background when `/reload` happened belongs to the new
    // runtime: the task registry lives on the same manager, and `bg_wait`/`bg_stop` go by task id.
    const agent = makeTempDir("replmode-agent-");
    const env = { PI_REPLMODE_MAX_CHANNELS: "12" };
    const first = await loadExtension({ agentDir: agent.path, env });
    const task = await first.callTool("run", {
      code: "import time\nfor _ in range(4): time.sleep(0.5)\nprint('finished on its own')",
      channel: "x-bgreload",
      timeout: 0,
    });
    expect(task.details.status).toBe("running");

    await first.emit({ type: "session_shutdown", reason: "reload" });
    first.dispose();
    vi.resetModules();

    const second = await loadExtension({ agentDir: agent.path, env });
    const waited = await second.callTool("bg_wait", { timeout: 20 });
    const listing = text(waited);
    expect(listing).toContain(task.details.id);
    expect(listing).toContain("completed");

    // The channel and its variables survived too, and the second runtime can still use them.
    const state = await second.callTool("run", { code: "print('state kept')", channel: "x-bgreload" });
    expect(text(state)).toContain("state kept");
    expect(text(state)).not.toContain("[new channel");

    await second.emit({ type: "session_shutdown", reason: "quit" });
    second.dispose();
    agent.dispose();
  });

  it("keeps channels alive across a session replacement, and shuts them down on quit", async () => {
    const agent = makeTempDir("replmode-agent-");
    const first = await loadExtension({ agentDir: agent.path, env: { PI_REPLMODE_MAX_CHANNELS: "12" } });
    const started = await first.callTool("run", { code: "print(1)", channel: "x-new" });
    const pid = started.details.pid;

    for (const reason of ["new", "resume", "fork"] as const) {
      await first.emit({ type: "session_shutdown", reason });
      expect(isPidAlive(pid), reason).toBe(true);
    }

    await first.emit({ type: "session_shutdown", reason: "quit" });
    await waitFor(() => !isPidAlive(pid), 15_000, "the channel daemon to exit");
    first.dispose();
    agent.dispose();
  });
});

describe("the channel cap", () => {
  it("retires the idlest channel rather than starting another daemon", async () => {
    const agent = makeTempDir("replmode-agent-");
    const ext = await loadExtension({ agentDir: agent.path });
    const saved = process.env.PI_REPLMODE_MAX_CHANNELS;
    process.env.PI_REPLMODE_MAX_CHANNELS = "2";
    try {
      const a = await ext.callTool("run", { code: "marker = 'a'", channel: "x-cap1" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await ext.callTool("run", { code: "print(1)", channel: "x-cap2" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await ext.callTool("run", { code: "print(1)", channel: "x-cap3" });

      await waitFor(() => !isPidAlive(a.details.pid), 15_000, "the idlest channel to be retired");

      // Its state is gone with it, and the next call says so by starting fresh.
      const back = await ext.callTool("run", { code: "print(marker)", channel: "x-cap1" });
      expect(text(back)).toContain("[new channel");
      expect(back.isError).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.PI_REPLMODE_MAX_CHANNELS;
      else process.env.PI_REPLMODE_MAX_CHANNELS = saved;
      await ext.emit({ type: "session_shutdown", reason: "quit" });
      ext.dispose();
      agent.dispose();
    }
  });

  it("refuses rather than exceeding the cap when every channel is busy", async () => {
    const agent = makeTempDir("replmode-agent-");
    const ext = await loadExtension({ agentDir: agent.path });
    const saved = process.env.PI_REPLMODE_MAX_CHANNELS;
    process.env.PI_REPLMODE_MAX_CHANNELS = "1";
    try {
      const busy = await ext.callTool("run", { code: "import time\ntime.sleep(4)", channel: "x-full", timeout: 1 });
      const refused = await ext.callTool("run", { code: "print(1)", channel: "x-second" });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("busy");
      expect(text(refused)).toContain("PI_REPLMODE_MAX_CHANNELS");
      // The busy channel is untouched: its task is still there to stop.
      expect(text(await ext.callTool("bg_wait", { timeout: 15 }))).toContain(busy.details.id);
    } finally {
      if (saved === undefined) delete process.env.PI_REPLMODE_MAX_CHANNELS;
      else process.env.PI_REPLMODE_MAX_CHANNELS = saved;
      await ext.emit({ type: "session_shutdown", reason: "quit" });
      ext.dispose();
      agent.dispose();
    }
  });
});
