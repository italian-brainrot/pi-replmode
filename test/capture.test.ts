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

describe("a cell that damages the capture stream", () => {
  it("R1-06: is not reported as completed when the channel dies underneath it", async () => {
    // fd 2 is the capture pipe; the closing sentinel is written to it in a `finally`, so the write
    // fails, the daemon's serve task dies, and the exec_end frame has already been sent. The call
    // must not come back as an ordinary success: the channel and its variables are gone.
    await run("durable = 'kept'", { channel: "c-fd2" });
    const result = await run("import os\nprint('printed before closing fd 2')\nos.close(2)\nprint('and after')", { channel: "c-fd2" });

    const shown = text(result);
    expect(shown).toContain("printed before closing fd 2");

    // Either the channel really survived having its capture stream destroyed, or the result says so.
    // Today it does neither: it comes back `completed`, and the state is gone by the next call.
    const next = await run("print(durable)", { channel: "c-fd2" });
    const survived = text(next).includes("kept") && !text(next).includes("[new channel");
    const disclosed = /(ended|dead|gone|capture)/i.test(shown);
    expect(survived || disclosed, `a dead channel reported success: ${shown.slice(0, 300)}`).toBe(true);
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

  it("R1-08: puts a flood from an orphan in the log of the cell that spawned it, and caps it", async () => {
    // The same defect at volume: a process that streams forever must not grow host memory or a log
    // without limit, and its bytes must not wander into whatever cell happens to run next.
    const first = await run("import subprocess\nsubprocess.Popen(['bash', '-c', 'seq 1 100000'])\nprint('spawned a flood')", {
      channel: "c-flood",
    });
    expect(text(first)).toContain("spawned a flood");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const logPath = join(ext.agentDir, "replmode", "exec", `${first.details.id}.log`);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("\n20000\n");
    expect(log, "the orphan's output is not attributed").toContain("after this cell ended");
    expect(log.length, "the late output is not capped").toBeLessThan(512 * 1024);
    expect(log).toContain("dropped");

    const next = await run("print('CELL-TWO')", { channel: "c-flood" });
    const shown = text(next);
    expect(shown).toContain("CELL-TWO");
    expect(shown, "the flood leaked into the next cell").not.toContain("99999");
  });

  it("R2-07: an orphan that writes while a later cell runs is not presented as that cell's output", async () => {
    // R1-08 fixed the bytes that arrive *between* blocks. The harder half is the bytes that arrive
    // while some other cell's block is open: at the file-descriptor level they are indistinguishable
    // from that cell's own output, so the host either separates the streams or says so.
    await run(
      "import subprocess\nsubprocess.Popen(['bash','-c','for i in $(seq 1 40); do echo ORPHIN-$i; sleep 0.05; done'])\nprint('spawned a talkative child')",
      { channel: "c-orphanblock" },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = await run("import time\nprint('SLOW-CELL start')\ntime.sleep(2)\nprint('SLOW-CELL end')", { channel: "c-orphanblock" });
    const shown = text(second);
    expect(shown).toContain("SLOW-CELL end");
    const contaminated = /ORPHIN-/.test(shown);
    const disclosed = /(after .* ended|not from this cell|another process|earlier cell)/i.test(shown);
    expect(contaminated && !disclosed, `another cell's child wrote into this cell's own output: ${shown.slice(0, 400)}`).toBe(false);
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

  it("R2-01: still shows the end of a log it could not read whole", async () => {
    // The head-and-tail promise is the whole point of the truncation, and a tail window is exactly
    // where it matters most: the last lines of a long run are the ones that say what happened.
    const result = await run("for i in range(200000): print(f'line {i} ' + 'pad' * 15)\nprint('THE VERY LAST LINE')", {
      channel: "c-tailcut",
      timeout: 180,
    });
    const shown = text(result);
    expect(result.details.truncated, "the log was not truncated after all").toBe(true);
    expect(shown, `the end of the log is missing from the result: ${shown.slice(-400)}`).toContain("THE VERY LAST LINE");
  });

  it("R2-01: keeps the end of a log whose last line is bigger than the whole tail budget", async () => {
    // A progress bar, a one-line JSON blob, a parquet header dumped to stdout: the last line of a long
    // run can be megabytes. The tail cut cannot land on a line boundary there, and it must still land
    // inside that line rather than after it.
    const result = await run("for i in range(90): print('L' * 100_000)\nprint('!' * 3_000_000 + ' THE VERY LAST LINE')", {
      channel: "c-gianttail",
      timeout: 180,
    });
    const shown = text(result);
    expect(result.details.truncated, "the log was not truncated after all").toBe(true);
    expect(shown, `the end of a megabyte final line is missing: ${shown.slice(-300)}`).toContain("THE VERY LAST LINE");
  });

  it("says what it gave up on counting once the log passes the scan limit", async () => {
    // `countOutput` stops at 16 MB, so the totals quoted for a bigger log are a floor, and the note
    // has to read like one.
    const result = await run("for i in range(320000): print(f'line {i} ' + 'pad' * 15)", { channel: "c-countcap", timeout: 240 });
    const shown = text(result);
    const note = /showing [\d]+ of (at least )?(\d+) characters/.exec(shown);
    expect(note, `no truncation note in: ${shown.slice(-600)}`).not.toBeNull();
    expect(Number(note![2]), "the scan cap should have been reached").toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(note![1], `a log past the scan limit is reported as if it were counted exactly: ${note![0]}`).toBe("at least ");
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
