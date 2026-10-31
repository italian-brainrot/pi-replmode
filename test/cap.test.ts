/**
 * Session bookkeeping: the channel cap under pressure, and the log retention sweep.
 *
 * Both only ever run in the awkward cases - every channel busy, a log left over from a session that
 * ended days ago - and neither is reachable from the rest of the suite, which keeps the cap high and
 * the agent dir fresh.
 */

import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPidAlive, type LoadedExtension, loadExtension, text } from "./helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ env: { PI_REPLMODE_MAX_CHANNELS: "1" } });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
});

describe("the channel cap", () => {
  it("R2-03: a burst of parallel calls on new channels does not walk past the cap", async () => {
    // The prompt tells the model to use separate channels for independent work, and `run` is
    // registered with `executionMode: "parallel"`, so several channels are created at the same instant.
    // Each one measures the cap before any of them exists, so none of them evicts anything.
    const saved = process.env.PI_REPLMODE_MAX_CHANNELS;
    process.env.PI_REPLMODE_MAX_CHANNELS = "2";
    try {
      const started = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => ext.callTool("run", { code: `print(${n})`, channel: `k-par${n}`, timeout: 30 })),
      );
      const pids = started.map((result) => result.details.pid).filter((pid) => pid !== undefined) as number[];
      const live = pids.filter((pid) => isPidAlive(pid));
      expect(live.length, `${live.length} channel daemons are alive with the cap set to 2`).toBeLessThanOrEqual(2);
    } finally {
      if (saved === undefined) delete process.env.PI_REPLMODE_MAX_CHANNELS;
      else process.env.PI_REPLMODE_MAX_CHANNELS = saved;
      await ext.emit({ type: "session_shutdown", reason: "quit" });
    }
  });

  it("R2-03: at a cap of one, a burst leaves exactly one daemon and refusals that are not start failures", async () => {
    // The cap of 1 is the tightest arithmetic the manager has: the first call occupies the only slot
    // while it is still starting, and the other two have no idle channel to evict. They must be refused
    // as a capacity problem (nothing died, nothing failed to start), and nothing may be left running.
    const started = await Promise.all(
      [1, 2, 3].map((n) => ext.callTool("run", { code: `print(${n})`, channel: `k-one${n}`, timeout: 30 })),
    );
    const pids = started.map((result) => result.details.pid).filter((pid) => pid !== undefined) as number[];
    const live = pids.filter((pid) => isPidAlive(pid));
    expect(live.length, `${live.length} daemons alive with a cap of 1: ${pids.join(", ")}`).toBeLessThanOrEqual(1);

    const refused = started.filter((result) => result.isError);
    expect(refused.length, "every parallel call got a channel, which the cap forbids").toBeGreaterThan(0);
    for (const result of refused) {
      const shown = text(result);
      expect(shown, `a capacity refusal is dressed as a channel that failed to start: ${shown}`).not.toContain("could not start");
      expect(result.structuredContent?.status, `a refusal that killed nothing reports status ${result.structuredContent?.status}`).toBe(
        "running",
      );
    }

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    for (const pid of pids) {
      expect(isPidAlive(pid), `channel daemon ${pid} outlived the session`).toBe(false);
    }
  });

  it("refuses a new channel when every existing one is busy, and says how to free one", async () => {
    const busy = await ext.callTool("run", { code: "import time\ntime.sleep(5)", channel: "k-busy", timeout: 0 });
    expect(busy.details.status).toBe("running");

    const result = await ext.callTool("run", { code: "print('need a channel')", channel: "k-new", timeout: 10 });
    expect(result.isError).toBe(true);
    const shown = text(result);
    expect(shown).toContain("are busy");
    expect(shown).toContain("PI_REPLMODE_MAX_CHANNELS");
    expect(shown).toContain("bg_stop");

    // An idle channel is reclaimed instead, with its variables going quietly.
    await ext.callTool("bg_wait", { timeout: 20 });
    const kept = await ext.callTool("run", { code: "print('now there is room')", channel: "k-new", timeout: 10 });
    expect(text(kept)).toContain("now there is room");
  });
  it("R2-03: and five parallel calls on the same new name start exactly one daemon", async () => {
    // The cap counts names, and `getChannel` dedupes an in-flight creation by name. Both halves matter:
    // without the dedupe the burst below would start five interpreters for one channel and the cap would
    // refuse four of them; without the cap counting `starting`, a burst on five *different* names walks
    // past it (the other test). The calls then queue on the channel's lock, which is the documented
    // behaviour for one channel.
    const saved = process.env.PI_REPLMODE_MAX_CHANNELS;
    process.env.PI_REPLMODE_MAX_CHANNELS = "2";
    try {
      const started = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => ext.callTool("run", { code: `print(${n})`, channel: "k-same", timeout: 30 })),
      );
      const pids = started.map((result) => result.details.pid).filter((pid) => pid !== undefined) as number[];
      expect(pids, "a call did not get a channel").toHaveLength(5);
      expect(new Set(pids).size, `five calls on one channel name started ${new Set(pids).size} interpreters`).toBe(1);
      for (const result of started) expect(result.isError, "a call on a shared channel was refused").toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.PI_REPLMODE_MAX_CHANNELS;
      else process.env.PI_REPLMODE_MAX_CHANNELS = saved;
      await ext.emit({ type: "session_shutdown", reason: "quit" });
    }
  });

  it("R4-05: does not blame the cap on an env var whose value it threw away", async () => {
    // `intEnv` falls back to the default for a value it cannot use, which is reasonable — but the only
    // place the cap is ever *reported* is the refusal, and the refusal says "the cap (4, set with
    // PI_REPLMODE_MAX_CHANNELS)". With `PI_REPLMODE_MAX_CHANNELS=0` the model and the user are told a
    // number the variable did not ask for, and a reasonable way to turn the feature off reads like a
    // working setting. Either honour it, or say that the configured value was not usable.
    const saved = process.env.PI_REPLMODE_MAX_CHANNELS;
    process.env.PI_REPLMODE_MAX_CHANNELS = "0";
    try {
      const busy = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          ext.callTool("run", { code: `import time\ntime.sleep(4) # k-zero${n}`, channel: `k-zero${n}`, timeout: 0 }),
        ),
      );
      for (const started of busy) expect(started.details.status, "a channel was refused before the cap was reached").toBe("running");

      const refused = await ext.callTool("run", { code: "print('need a channel')", channel: "k-zero5", timeout: 10 });
      expect(refused.isError, "a fifth channel was given with the cap set to 0").toBe(true);
      const shown = text(refused);
      expect(shown, `the refusal does not name the cap it applied: ${shown}`).toContain("PI_REPLMODE_MAX_CHANNELS");
      expect(shown, `the refusal attributes a cap of 4 to PI_REPLMODE_MAX_CHANNELS=0: ${shown}`).toMatch(
        /default|ignored|not a valid|cannot be used|usable/,
      );

      await ext.callTool("bg_wait", { timeout: 30 });
    } finally {
      if (saved === undefined) delete process.env.PI_REPLMODE_MAX_CHANNELS;
      else process.env.PI_REPLMODE_MAX_CHANNELS = saved;
      await ext.emit({ type: "session_shutdown", reason: "quit" });
    }
  });
});

describe("retention at session_start", () => {
  it("deletes exec logs the age and count rules cover, and keeps the rest", async () => {
    const dir = join(ext.agentDir, "replmode", "exec");
    mkdirSync(dir, { recursive: true });

    const ancient = join(dir, "repl-ancien1.log");
    writeFileSync(ancient, "from a session days ago\n");
    const when = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(ancient, when, when);

    const recent = join(dir, "repl-recent.log");
    writeFileSync(recent, "from today\n");
    const other = join(dir, "not-an-exec-log.txt");
    writeFileSync(other, "someone else's file\n");

    await ext.emit({ type: "session_start", sessionId: "sweep" });

    expect(existsSync(ancient), "a log older than the retention window survived the sweep").toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(other), "the sweep touched a file that is not an exec log").toBe(true);
  });
});
