/**
 * Everything that reaches a tool result but is not the cell's capture.
 *
 * The 50 000-character limit is a promise about the *answer*. The capture and the traceback were both
 * given explicit budgets (R1-09, R2-01, R2-02), but a `run` result also carries text the daemon chose
 * (its `log` frames, the names the cell bound) and text the host adds around it. This file holds those
 * to the same promise, and re-attacks the traceback budget at its seams: a windowed log and an
 * enormous traceback at once, a traceback that fits, recursion collapsed by IPython.
 *
 * Tests whose comment names an issue id (R3-nn) document a defect from the pass-3 audit and are
 * expected to fail until it is fixed.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_OUTPUT_CHARS } from "../src/format.ts";
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

describe("text the daemon chooses", () => {
  it("R3-01: a cell cannot make the daemon's own log lines blow the answer limit", async () => {
    // The daemon copies every `log` frame into the host's note ring, and a dead channel's result pastes
    // the last few of them under "daemon said:". The ring is capped by *count*, not by bytes, and a cell
    // can put as many bytes as it likes into one frame — the SIGINT-disposition warning quotes whatever
    // the cell's own handler is called, which is the cell's `__name__`.
    await run(
      "f = lambda *a: None\nf.__name__ = 'x' * 300_000\nimport signal\nsignal.signal(signal.SIGINT, f)\nprint('handler installed')",
      {
        channel: "l-notes",
      },
    );
    // The next cell is where the daemon notices and reports it: one `log` frame, one huge string.
    await run("print('second cell')", { channel: "l-notes" });
    const dead = await run("import os\nos._exit(3)", { channel: "l-notes" });

    const shown = text(dead);
    expect(shown, `the death of the channel is reported: ${shown}`).toContain("ended (exit code 3)");
    expect(shown.length, `the result is ${shown.length} characters: the daemon's log frames are pasted in without a bound`).toBeLessThan(
      MAX_OUTPUT_CHARS + 5_000,
    );
  });

  it("R3-01: and cannot do it with the names a cell bound", async () => {
    // `definitions` is capped at 100 *names*, which is not the same as a cap on characters: an
    // identifier may be 4095 of them. The note naming what the cell defined, and `details.definitions`,
    // carry every one.
    const names = Array.from({ length: 30 }, (_, index) => "x".repeat(3000) + index);
    const result = await run(`for n in ${JSON.stringify(names)}:\n    exec(n + " = 1")`, { channel: "l-defs" });

    const shown = text(result);
    expect(shown, `the cell's definitions are no longer reported at all: ${shown.slice(-300)}`).toContain("defined by this cell");
    expect(shown.length, `the result is ${shown.length} characters: the definitions note gets no share of the limit`).toBeLessThan(
      MAX_OUTPUT_CHARS + 5_000,
    );
  });

  it("R3-01: and those names do not end up in the prompt the next session starts with", async () => {
    // Whatever a cell binds is recorded in the channel's history (up to 20 names per record) and quoted
    // back at the model as a prompt section by the next session. The bound that matters is against the
    // section the same channel produces when it binds nothing remarkable: one cell's identifier lengths
    // must not be able to move it.
    const measure = async () => {
      const sections: Record<string, string> = {};
      await ext.emit({ type: "session_start", sessionId: `l-hint-${Date.now()}-${Math.random()}` }, { hasUI: true });
      await ext.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: { sections } });
      return sections.replmode ?? "";
    };

    // A channel that has run out of daemon is the one whose last cell gets quoted, so each measurement
    // runs its cell in the background, waits for it to be recorded, and then takes the channel down.
    const lastCell = async (code: string) => {
      const started = await run(code, { channel: "l-hint", timeout: 0 });
      await ext.callTool("bg_wait", { timeout: 20 });
      await ext.callTool("bg_stop", { task_id: started.details.id, kill: true });
    };

    await lastCell("answer = 42");
    const baseline = await measure();
    expect(baseline, "the section no longer names what a cell defined").toContain("defined:");

    const names = Array.from({ length: 20 }, (_, index) => "y".repeat(3000) + index);
    await lastCell(`for n in ${JSON.stringify(names)}:\n    exec(n + " = 1")`);

    const after = await measure();
    expect(after, "the section no longer names what a cell defined").toContain("defined:");
    expect(
      after.length,
      `the prompt section grew from ${baseline.length} to ${after.length} characters because of the names one cell bound`,
    ).toBeLessThan(baseline.length + 2_000);
  });
});

describe("the traceback budget, at its seams", () => {
  it("R2-02: survives deep recursion whose exception message is enormous", async () => {
    // IPython collapses repeated frames, so the recursion depth was never the hole; the message is.
    // Both together is the worst case the daemon can be asked for.
    const result = await run(
      "import sys\nsys.setrecursionlimit(4000)\ndef rec(n):\n    if n == 0:\n        raise ValueError('boom: ' + 'q' * 200_000)\n    return rec(n - 1)\nrec(1500)",
      { channel: "l-deep" },
    );
    const shown = text(result);
    expect(result.isError).toBe(true);
    expect(shown.length, `the answer is ${shown.length} characters`).toBeLessThan(MAX_OUTPUT_CHARS + 5_000);
    expect(shown).toContain("ValueError");
    expect(shown, "a shortened traceback is not reachable in full").toContain("full traceback:");
  });

  it("R2-02: a windowed log and an enormous traceback at once, both cut, both reachable", async () => {
    // Both truncations are live in one answer: the capture is bigger than the read window (so the
    // totals come from the file and are a floor), and the exception's message is bigger than the
    // traceback's share of the limit.
    const result = await run("for i in range(45_000): print('p' * 200)\nraise ValueError('unparseable: ' + 'x' * 300_000)", {
      channel: "l-both",
      timeout: 180,
    });
    const shown = text(result);
    expect(shown.length, `the answer is ${shown.length} characters`).toBeLessThan(MAX_OUTPUT_CHARS + 5_000);
    expect(shown).toContain("ValueError");

    const log = readFileSync(result.details.fullOutputPath!, "utf8");
    expect(log.length, "the log is smaller than the capture that was reported").toBeGreaterThan(8 * 1024 * 1024);
    expect(log, "the full traceback was not appended to the log the notes point at").toContain("x".repeat(300_000));

    // Two notes, and the output one has to keep the "at least" floor for a log past the scan limit.
    expect(shown, "the output note is missing").toMatch(/output truncated: showing \d+ of (at least )?\d+ characters/);
    expect(shown, "the traceback note is missing").toMatch(
      /traceback truncated: showing \d+ of \d+ characters at the start and \d+ at the end/,
    );
  });

  it("R3-09: and the totals it quotes still describe the file it sends the model to", async () => {
    // R2-02 writes the full traceback into the exec log — the one truncation in this code that changes
    // the file the notes point at. The totals are counted before that happens, so the answer quotes one
    // number for a file that is now longer, which is the R1-09 mistake in miniature.
    const result = await run("for i in range(45_000): print('p' * 200)\nraise ValueError('unparseable: ' + 'x' * 300_000)", {
      channel: "l-totals",
      timeout: 180,
    });
    const shown = text(result);
    const note = /output truncated: showing \d+ of (\d+) characters/.exec(shown);
    expect(note, `no output truncation note in: ${shown.slice(-400)}`).not.toBeNull();

    const onDisk = readFileSync(result.details.fullOutputPath!, "utf8").length;
    const claimed = Number(note![1]);
    expect(
      claimed,
      `the note says the log holds ${claimed} characters; the file it sends the model to holds ${onDisk}`,
    ).toBeGreaterThanOrEqual(onDisk);
  });

  it("R2-02: reserves nothing for a traceback that already fits", async () => {
    // The share is a floor for the traceback, not a tax on the capture: a cell that printed past the
    // limit and raised a one-line error still gets its output, and the traceback is not cut to make
    // room for a payload that never arrived.
    const result = await run("print('y' * 60_000)\nraise ValueError('short reason')", { channel: "l-fits" });
    const shown = text(result);
    expect(shown.length, `the answer is ${shown.length} characters`).toBeLessThan(MAX_OUTPUT_CHARS + 5_000);
    expect(shown).toContain("output truncated");
    expect(shown, "the traceback was cut although the answer had room for it").not.toContain("traceback truncated");
    expect(shown).toContain("short reason");
  });
});
