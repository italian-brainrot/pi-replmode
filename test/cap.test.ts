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
import { type LoadedExtension, loadExtension, text } from "./helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ env: { PI_REPLMODE_MAX_CHANNELS: "1" } });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
});

describe("the channel cap", () => {
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
