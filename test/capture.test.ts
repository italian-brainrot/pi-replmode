/**
 * Capture attribution and the output limit, under abuse.
 *
 * `run.test.ts` covers the contract when the cell behaves: its output arrives between its own
 * sentinels on fd 1 or fd 2. This file checks what happens when the cell damages the streams the
 * attribution depends on — closing or redirecting the capture descriptor, writing the boundary
 * marker itself, leaving a process that keeps writing after the cell ends — and what the 50 000
 * character limit promises when the log is far bigger than the read window.
 *
 * Tests whose comment names an issue id (R1-nn) document a defect from the pass-1 audit and are
 * expected to fail until it is fixed.
 */

import { readFileSync } from "node:fs";
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

describe("a cell that damages the capture stream", () => {
  it("R1-06: is not reported as completed when the channel dies underneath it", async () => {
    // fd 2 is the capture pipe; the closing sentinel is written to it in a `finally`, so the write
    // fails, the daemon's serve task dies, and the exec_end frame has already been sent. The call
    // must not come back as an ordinary success: the channel and its variables are gone.
    await run("durable = 'kept'", { channel: "c-fd2" });
    const result = await run("import os\nprint('printed before closing fd 2')\nos.close(2)\nprint('and after')", { channel: "c-fd2" });

    const shown = text(result);
    expect(shown).toContain("printed before closing fd 2");
    expect(result.details.status === "completed", `a dead channel reported success: ${shown.slice(0, 300)}`).toBe(false);
    expect(shown).toMatch(/ended|dead|gone/);

    // Whatever the model does next must not pretend the channel is the same one.
    const next = await run("print(durable)", { channel: "c-fd2" });
    expect(text(next)).not.toContain("kept");
  });

  it("still answers promptly and keeps the traceback when the capture stream is redirected", async () => {
    // Nothing will ever arrive on the capture pipe again, so the closing sentinel never lands: the
    // host has to stop waiting for it, and the traceback still has to reach the model via the frame.
    await run("import os\nos.dup2(os.open('/dev/null', os.O_WRONLY), 2)\nprint('redirected')", { channel: "c-devnull" });
    const started = Date.now();
    const result = await run("1 / 0", { channel: "c-devnull" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("ZeroDivisionError");
  });
});

describe("boundary markers in the output", () => {
  it("R1-07: a marker the cell writes itself must not eat the rest of its output", async () => {
    // The marker is seven bytes plus an exec id; a program printing binary or log data can produce
    // it by accident, and DESIGN.md promises "a cosmetic block split" for a false positive.
    const result = await run(
      "import sys\nprint('BEFORE-MARKER')\nsys.stdout.buffer.write(b'\\x00\\x1ePIRB\\x1erepl-notreal\\n')\nsys.stdout.flush()\nprint('AFTER-MARKER')",
      { channel: "c-marker" },
    );
    const shown = text(result);
    expect(shown).toContain("BEFORE-MARKER");
    expect(shown, `the cell's own output was dropped: ${shown.slice(0, 300)}`).toContain("AFTER-MARKER");

    const next = await run("print('CELL-TWO')", { channel: "c-marker" });
    const nextShown = text(next);
    expect(nextShown).toContain("CELL-TWO");
    expect(nextShown, `the previous cell's output leaked into the next one: ${nextShown.slice(0, 300)}`).not.toContain("AFTER-MARKER");
  });
});

describe("a process that outlives its cell", () => {
  it("R1-08: must not have its output presented as the next cell's output", async () => {
    // A backgrounded server, a `Popen` the model never waited for: its bytes arrive while no block
    // is open, and the host attaches loose bytes to the block that follows them.
    const first = await run(
      "import subprocess\nchild = subprocess.Popen(['bash','-c','for i in $(seq 1 30); do echo ORPHAN-$i; sleep 0.1; done'])\nprint('cell one done')",
      { channel: "c-orphan" },
    );
    expect(text(first)).toContain("cell one done");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const second = await run("print('CELL-TWO-OUTPUT')", { channel: "c-orphan" });
    const shown = text(second);
    expect(shown).toContain("CELL-TWO-OUTPUT");
    const contaminated = shown.includes("ORPHAN-");
    const disclosed = /(earlier|previous cell|after .*ended|not from this cell)/i.test(shown);
    expect(contaminated && !disclosed, `another cell's output is presented as this cell's: ${shown.slice(0, 400)}`).toBe(false);

    const third = await run("print('CELL-THREE')", { channel: "c-orphan" });
    expect(text(third)).not.toContain("ORPHAN-");
  });
});

describe("a log bigger than the read window", () => {
  it("keeps the tail, writes the whole thing, and binds the whole text", async () => {
    const result = await run("for i in range(200000): print(f'line {i} ' + 'pad' * 15)", { channel: "c-window", timeout: 180 });
    const shown = text(result);
    expect(result.details.status).toBe("completed");
    expect(result.details.truncated).toBe(true);
    expect(shown).toContain("showing its tail");

    const logPath = result.details.fullOutputPath!;
    expect(readFileSync(logPath, "utf8").length).toBeGreaterThan(8 * 1024 * 1024);
    const tail = await run(`print(len(${result.details.varName}), ${result.details.varName}.splitlines()[-1])`, { channel: "c-window" });
    expect(text(tail)).toContain("line 199999");
  });

  it("R1-09: says how much there really is, not how much of it was read", async () => {
    const result = await run("for i in range(200000): print(f'line {i} ' + 'pad' * 15)", { channel: "c-totals", timeout: 180 });
    const shown = text(result);
    const logChars = readFileSync(result.details.fullOutputPath!, "utf8").length;
    const note = /showing (\d+) of (\d+) characters/.exec(shown);
    expect(note, `no truncation note in: ${shown.slice(-600)}`).not.toBeNull();
    const claimed = Number(note![2]);
    // The note reads "showing X of N characters", so N has to be the log's size. `readLog` returns a
    // tail window, and the window's length is what gets reported today.
    expect(claimed, `the note claims ${claimed} characters for a ${logChars} character log`).toBeGreaterThanOrEqual(logChars * 0.98);
  });
});

describe("bytes that are not text", () => {
  it("survive the capture pipe without breaking the call", async () => {
    const result = await run("import sys\nsys.stdout.buffer.write(b'binary \\x00\\x01\\xfe\\xff tail\\n')\nprint('done')", {
      channel: "c-binary",
    });
    expect(result.details.status).toBe("completed");
    const shown = text(result);
    expect(shown).toContain("binary");
    expect(shown).toContain("tail");
    expect(shown).toContain("done");
  });
});
