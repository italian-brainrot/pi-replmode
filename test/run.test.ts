/**
 * `run`, end to end: a real daemon, real pipes, real Python.
 *
 * These are the behaviours the rest of the design stands on — state that persists, output captured
 * at the file-descriptor level, a failure that leaves the channel alone, and the 50 000 character
 * limit that hands the model a log path and a global instead of a truncation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

const run = (code: string, params: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
  ext.callTool("run", { code, ...params }, options);

describe("a fresh channel", () => {
  it("reports what it started and where", async () => {
    const result = await run("print('hello')", { channel: "t-new" });
    const shown = text(result);
    expect(shown).toContain(`[new channel "t-new"`);
    expect(shown).toContain("python 3.");
    expect(shown).toContain("ipython 9.");
    expect(shown).toContain(ext.cwd);
    expect(shown).toContain("hello");
    expect(result.details.status).toBe("completed");
    expect(result.details.id).toMatch(/^repl-[0-9a-z]{8}$/);

    const again = await run("print('second')", { channel: "t-new" });
    expect(text(again)).not.toContain("[new channel");
  });

  it("runs where the session is working", async () => {
    const result = await run("import os\nprint(os.getcwd())", { channel: "t-cwd" });
    expect(text(result)).toContain(ext.cwd);
  });
});

describe("state", () => {
  it("keeps variables, imports and functions between calls", async () => {
    await run("import math\ndef double(n):\n    return n * 2\nvalue = 21", { channel: "t-state" });
    const result = await run("print(double(value + math.pi))", { channel: "t-state" });
    expect(text(result)).toContain("48.283185307179586");
  });

  it("shows the repr of a trailing expression, like a REPL", async () => {
    await run("payload = {'a': [1, 2]}", { channel: "t-repr" });
    const result = await run("payload", { channel: "t-repr" });
    expect(text(result)).toContain("{'a': [1, 2]}");
  });

  it("names what a cell defined", async () => {
    const result = await run("radius = 3\narea = 3.14 * radius ** 2", { channel: "t-defs" });
    expect(result.details.definitions).toEqual(expect.arrayContaining(["radius", "area"]));
  });

  it("reports the channel it is running in", async () => {
    const result = await run("print(pi.channel, bool(pi.cwd), pi.python_version)", { channel: "t-pi" });
    expect(text(result)).toMatch(/t-pi True 3\./);
  });
});

describe("capture", () => {
  it("catches stdout, stderr, subprocesses and magics in order", async () => {
    const result = await run("import sys, os\nprint('one')\nprint('two', file=sys.stderr)\nos.system('echo three')\nprint('four')", {
      channel: "t-capture",
    });
    const shown = text(result);
    for (const marker of ["one", "two", "three", "four"]) {
      expect(shown).toContain(marker);
    }
    expect(shown.indexOf("one")).toBeLessThan(shown.indexOf("four"));
  });

  it("keeps one cell's output out of the next cell's result", async () => {
    await run("print('MARKER-FIRST')", { channel: "t-split" });
    const second = await run("print('MARKER-SECOND')", { channel: "t-split" });
    const shown = text(second);
    expect(shown).toContain("MARKER-SECOND");
    expect(shown).not.toContain("MARKER-FIRST");
  });

  it("runs magics, bang commands and top-level await", async () => {
    const bang = await run("!echo from-bang", { channel: "t-magic" });
    expect(text(bang)).toContain("from-bang");
    const magic = await run("import os\n%who_ls", { channel: "t-magic" });
    expect(text(magic)).toContain("os");
    const awaited = await run("import asyncio\nawait asyncio.sleep(0.05)\nprint('awaited')", { channel: "t-magic" });
    expect(text(awaited)).toContain("awaited");
  });

  it("keeps unicode output intact", async () => {
    const result = await run("print('héllo ✓ 日本語')", { channel: "t-unicode" });
    expect(text(result)).toContain("héllo ✓ 日本語");
  });
});

describe("failure", () => {
  it("returns the traceback, marks the call failed, and keeps the channel", async () => {
    await run("survivor = 'still here'", { channel: "t-error" });
    const result = await run("def boom():\n    1 / 0\nboom()", { channel: "t-error" });
    expect(result.isError).toBe(true);
    const shown = text(result);
    expect(shown).toContain("ZeroDivisionError");
    expect(shown).toContain("boom()");
    expect(shown).not.toContain("\x1b[");
    expect(result.details.status).toBe("failed");
    expect(result.details.ename).toBe("ZeroDivisionError");

    const after = await run("print(survivor)", { channel: "t-error" });
    expect(text(after)).toContain("still here");
  });

  it("keeps output printed before the exception", async () => {
    const result = await run("print('partial output')\nraise ValueError('nope')", { channel: "t-partial" });
    const shown = text(result);
    expect(shown).toContain("partial output");
    expect(shown).toContain("ValueError: nope");
    expect(shown.indexOf("partial output")).toBeLessThan(shown.indexOf("ValueError"));
  });

  it("refuses an empty cell instead of starting a daemon for nothing", async () => {
    const result = await run("   ", { channel: "t-empty" });
    expect(result.isError).toBe(true);
  });
});

describe("the 50 000 character limit", () => {
  it("keeps head and tail, writes the log, and binds a global to slice", async () => {
    const result = await run("for i in range(8000): print(f'line {i:06d} of a very long output line')", { channel: "t-trunc" });
    const shown = text(result);
    expect(result.details.truncated).toBe(true);
    expect(shown).toContain("[output truncated:");
    expect(shown).toContain("not shown");
    expect(shown).toContain("line 000000");
    expect(shown).toContain("line 007999");
    expect(shown.length).toBeLessThan(60_000);

    const varName = result.details.varName!;
    expect(varName).toMatch(/^_out_/);
    const logPath = result.details.fullOutputPath!;
    expect(readFileSync(logPath, "utf8")).toContain("line 004000");

    const sliced = await run(`print(len(${varName}))`, { channel: "t-trunc" });
    expect(text(sliced)).toMatch(/\b3[0-9]{5}\b/);

    const head = await run(`print(${varName}.splitlines()[4000])`, { channel: "t-trunc" });
    expect(text(head)).toContain("line 004000");
  });

  it("leaves ordinary output untruncated and keeps no log note", async () => {
    const result = await run("print('short')", { channel: "t-short" });
    expect(result.details.truncated).toBe(false);
    expect(result.details.varName).toBeUndefined();
    expect(text(result)).not.toContain("truncated");
  });
});

describe("a channel that dies", () => {
  it("reports what it managed to print, then recreates the channel", async () => {
    const result = await run("print('last words')\nimport os\nos._exit(5)", { channel: "t-dying" });
    expect(result.isError).toBe(true);
    const shown = text(result);
    expect(shown).toContain("last words");
    expect(shown).toContain("ended");
    expect(result.details.status).toBe("dead");

    const fresh = await run("print('reborn')", { channel: "t-dying" });
    expect(text(fresh)).toContain("[new channel");
    expect(text(fresh)).toContain("reborn");
  });

  it("reports a daemon that cannot start at all", async () => {
    const broken = await loadExtension({ env: { PI_REPLMODE_PYTHON: "/nonexistent/python", PI_REPLMODE_MAX_CHANNELS: "12" } });
    const result = await broken.callTool("run", { code: "print(1)", channel: "t-broken" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("could not start");
    await broken.emit({ type: "session_shutdown", reason: "quit" });
    broken.dispose();
  });
});

describe("aborting a call", () => {
  it("interrupts the cell and keeps the channel's variables", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1200);
    const result = await run(
      "kept = 7\nimport time\nwhile True:\n    time.sleep(0.05)",
      { channel: "t-abort", timeout: 30 },
      { signal: controller.signal },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("interrupted");

    const after = await run("print(kept)", { channel: "t-abort" });
    expect(text(after)).toContain("7");
  });

  it("R4-06: a call cancelled while it waits for a busy channel never puts its cell on the wire", async () => {
    // Nothing about a start is involved here: the channel is live, and the call is queued behind another
    // call on it. The guard that matters is the one taken *after* the lock — a call that reaches its turn
    // and sends anyway has run a cell its user cancelled, and the start path cannot see that case at all.
    const marker = join(ext.agentDir, "queued-abort.txt");
    const holder = run("import time\nheld = 1\ntime.sleep(4)\nprint('holder done')", { channel: "t-queued", timeout: 30 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const controller = new AbortController();
    const queued = run(
      `open(${JSON.stringify(marker)}, "w").write("ran")`,
      { channel: "t-queued", timeout: 30 },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();

    const [first, second] = await Promise.all([holder, queued]);
    expect(text(first), "the cell that was holding the channel did not finish").toContain("holder done");
    const shown = text(second);
    expect(second.isError, `the cancelled queued call answered as if it had run: ${shown}`).toBe(true);
    expect(shown, `the cancelled queued call does not say it was cancelled: ${shown}`).toMatch(/aborted/);
    expect(existsSync(marker), "the cancelled call wrote its file, so its cell ran").toBe(false);
  });
});

describe("channels", () => {
  it("are separate worlds that run at the same time", async () => {
    await run("only_here = 'alpha'", { channel: "t-par-a" });
    const [other, overlap] = await Promise.all([
      run("print('only_here' in dir())", { channel: "t-par-b" }),
      (async () => {
        const started = Date.now();
        await run("import time\ntime.sleep(1.5)", { channel: "t-par-c", timeout: 10 });
        return Date.now() - started;
      })(),
    ]);
    expect(text(other)).toContain("False");
    expect(overlap).toBeLessThan(3500);
  });
});

describe("history", () => {
  it("records every cell so a later session can see what a lost channel held", async () => {
    await run("history_marker = 1", { channel: "t-hist" });
    const path = join(ext.agentDir, "replmode", "history", "t-hist.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const last = JSON.parse(lines.at(-1)!);
    expect(last.channel).toBe("t-hist");
    expect(last.code).toContain("history_marker");
    expect(last.status).toBe("completed");
  });
});
