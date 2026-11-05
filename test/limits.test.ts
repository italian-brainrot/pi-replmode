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

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_OUTPUT_CHARS } from "../src/format.ts";
import { channelFileStem } from "../src/names.ts";
import { emitPrompt, type LoadedExtension, loadExtension, promptText, text } from "./helpers/extension.ts";

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
    // back at the model in the guidelines of the next session. The bound that matters is against the
    // listing the same channel produces when it binds nothing remarkable: one cell's identifier lengths
    // must not be able to move it.
    const measure = async () => {
      await ext.emit({ type: "session_start", sessionId: `l-hint-${Date.now()}-${Math.random()}` }, { hasUI: true });
      return promptText(ext);
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
    expect(after, "the listing no longer names what a cell defined").toContain("defined:");
    expect(
      after.length,
      `the prompt listing grew from ${baseline.length} to ${after.length} characters because of the names one cell bound`,
    ).toBeLessThan(baseline.length + 2_000);
  });

  it("F3-01: and not with the name of the exception it raised", async () => {
    // Fixer hardening in the same class as R3-01, and the last field of a `run` result a cell can still
    // size: `type("n" * 3000, (Exception,), {})` is a legal class, and its `__name__` is what `ename`
    // carries — into `details`, into `structuredContent.error`, and into the task listing `bg_wait`
    // prints as `failed (<name>)`.
    const result = await run("E = type('n' * 3000, (Exception,), {})\nraise E('the reason')", { channel: "l-ename" });
    const shown = text(result);
    expect(shown.length, `the result is ${shown.length} characters`).toBeLessThan(MAX_OUTPUT_CHARS + 5_000);
    expect(shown, "the exception is no longer named at all").toContain("nnnn");
    expect((result.details.ename ?? "").length, `details.ename is ${(result.details.ename ?? "").length} characters`).toBeLessThanOrEqual(
      200,
    );
    const error = result.structuredContent?.error as { ename?: string } | undefined;
    expect((error?.ename ?? "").length, "structuredContent.error.ename is not clipped").toBeLessThanOrEqual(200);

    // The listing is the copy that reaches a model as text, in a result of a different tool.
    await run("E = type('m' * 3000, (Exception,), {})\nraise E('a background reason')", { channel: "l-ename-bg", timeout: 0 });
    const listed = await ext.callTool("bg_wait", { timeout: 30 });
    const listing = text(listed);
    expect(listing, "the task listing no longer says the cell failed").toContain("failed (");
    expect(listing.length, `the task listing is ${listing.length} characters because of an exception name`).toBeLessThan(5_000);
    for (const task of listed.details?.tasks ?? []) {
      expect((task.ename ?? "").length, `the listing reports ename as ${task.ename?.length} characters`).toBeLessThanOrEqual(200);
    }
  });

  it("F3-03: and the channel's history file does not keep the names whole either", async () => {
    // The result and the prompt listing are two copies of what a cell bound; the history file is the copy
    // that outlives the session and is re-read by every later one. Bounding it where it is written is what
    // keeps a 3001-character identifier from being carried around for ever, whatever later code quotes.
    const names = Array.from({ length: 20 }, (_, index) => `z`.repeat(3000) + index);
    await run(`for n in ${JSON.stringify(names)}:\n    exec(n + " = 1")`, { channel: "l-histsize" });

    const path = join(ext.agentDir, "replmode", "history", `${channelFileStem("l-histsize")}.jsonl`);
    const recorded = readFileSync(path, "utf8");
    expect(recorded, "the history file does not record what the cell defined").toContain('"definitions"');
    expect(recorded, "the history file kept no usable form of the names").toContain("z".repeat(60));
    expect(recorded, "a 3000-character remembered name was written whole to the history file").not.toContain("z".repeat(500));
    expect(recorded.length, `the history file for one channel is ${recorded.length} characters`).toBeLessThan(20_000);
  });

  it("F3-04: and the prompt listing bounds a name it is quoted from any history file", async () => {
    // The other half of the same bound: a history file may have been written by a build that did not clip
    // (or by anything else at all), so the listing has to shorten what it quotes rather than trust the
    // record. This is the copy that is re-sent on every request of every later session.
    const measure = async () => {
      await ext.emit({ type: "session_start", sessionId: `f3-04-${Date.now()}-${Math.random()}` }, { hasUI: true });
      return promptText(ext);
    };

    const before = await measure();
    const dir = join(ext.agentDir, "replmode", "history");
    mkdirSync(dir, { recursive: true });
    const names = Array.from({ length: 20 }, (_, index) => "q".repeat(3000) + index);
    const record = {
      ts: new Date(Date.now() + 60_000).toISOString(),
      id: "repl-hintq000",
      channel: "h-hintq",
      status: "completed",
      elapsed: 1,
      code: "for n in names: exec(n + ' = 1')",
      definitions: names,
    };
    writeFileSync(join(dir, "h-hintq.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    const after = await measure();
    expect(after, "the listing no longer names what a cell defined").toContain("defined:");
    expect(after, "a remembered 3000-character name is quoted whole in the prompt listing").not.toContain("q".repeat(300));
    expect(after.length, `the prompt listing grew from ${before.length} to ${after.length} over one remembered cell`).toBeLessThan(
      before.length + 1_000,
    );
    expect(readdirSync(dir), "the hand-written history file was rewritten by the way").toContain("h-hintq.jsonl");
  });

  it("R4-01: and the listing bounds the channel *name* it quotes from a history file", async () => {
    // F3-04 clipped the remembered *definitions* on the read path, because a history file may have been
    // written by a build that did not clip. The channel name is the other field of that same record, and
    // it is bounded only on the write side (F3-02's refusal, added in the same pass): the note pastes
    // `note.channel` raw. A file written before that refusal — or by anything else, which F3-04
    // already assumes — still sizes the prompt of every later session and the session_start notification
    // that lists the same names.
    const measure = async () => {
      await ext.emit({ type: "session_start", sessionId: `r4-01-${Date.now()}-${Math.random()}` }, { hasUI: true });
      const options = await emitPrompt(ext);
      return {
        listing: (options.promptGuidelines as string[]).join("\n"),
        notes: ext.notified.map((note) => note.message).join("\n"),
      };
    };

    const before = await measure();
    const dir = join(ext.agentDir, "replmode", "history");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "h-longname.jsonl"),
      `${JSON.stringify({
        ts: new Date(Date.now() + 60_000).toISOString(),
        id: "repl-longnm00",
        channel: `h-longname${"z".repeat(3000)}`,
        status: "completed",
        elapsed: 1,
        code: "answer = 42",
      })}\n`,
      "utf8",
    );

    const after = await measure();
    expect(after.listing, "a remembered channel is no longer reported as lost").toContain("answer = 42");
    expect(after.listing, "a 3000-character remembered channel name is quoted whole in the prompt listing").not.toContain("z".repeat(300));
    expect(
      after.listing.length,
      `the prompt listing grew from ${before.listing.length} to ${after.listing.length} characters over one remembered name`,
    ).toBeLessThan(before.listing.length + 1_000);
    expect(after.notes, "the restart notification quotes the whole remembered name as well").not.toContain("z".repeat(300));
  });

  it("R4-01: and a legal channel name cannot reshape the listing it is quoted into", async () => {
    // The other half of the same missing clip, reachable today with no foreign file involved: a channel
    // name may contain a newline (`run` only refuses names over 200 characters), the history record keeps
    // it whole, and each note is one guideline bullet that the name is pasted into raw. One cell
    // can put a bullet of its own choosing into the system prompt of every later session.
    const measure = async () => {
      await ext.emit({ type: "session_start", sessionId: `r4-01b-${Date.now()}-${Math.random()}` }, { hasUI: true });
      return promptText(ext);
    };

    // Measured twice, because by now this file has killed several channels of its own and the listing
    // already carries one bullet for each: what must not change is the number *this* channel adds. A
    // bullet is one entry of the guidelines list, so a name that carries a newline cannot split it — but
    // a name that carried a quote of its own could try to start a second bullet, and the count is what
    // catches that.
    const notesIn = (listing: string): number => listing.split("\n").filter((line) => line.includes("last cell")).length;
    const before = notesIn(await measure());

    // A channel that is gone by the next session boundary, so its last cell is the one that gets quoted.
    const started = await run("INJECTED_MARKER = 1", { channel: "h-inject\n- and a line the model wrote", timeout: 0 });
    await ext.callTool("bg_wait", { timeout: 20 });
    await ext.callTool("bg_stop", { task_id: started.details.id, kill: true });

    const shown = await measure();
    expect(shown, "the lost channel is no longer reported at all").toContain("INJECTED_MARKER");
    expect(shown, `a channel name put a second line into the listing:\n${shown.split("\n").slice(-6).join("\n")}`).not.toContain(
      "- and a line the model wrote",
    );
    const added = notesIn(shown) - before;
    expect(added, `one lost channel added ${added} note bullets to the listing, where it is allowed only one`).toBe(1);
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

  it("R3-09: and the line count it quotes comes from the same count as the character count", async () => {
    // R3-09 recounted the file after the traceback was appended, but only the character half of the note
    // was pinned. The line half is computed by the same call, and a note that says "1812 of 4873 lines"
    // for a file with different numbers is the same mistake in the other unit — with the extra wrinkle
    // that the host's own header line ("[full traceback for this cell]") is in the count.
    const result = await run("for i in range(3000): print('l' * 60)\nraise ValueError('unparseable: ' + 'x' * 300_000)", {
      channel: "l-linecounts",
    });
    const shown = text(result);
    const note = /output truncated: showing (\d+) of (\d+) characters at the start and (\d+) at the end \((\d+) of (\d+) lines\)/.exec(
      shown,
    );
    expect(note, `no output truncation note with both units in: ${shown.slice(-500)}`).not.toBeNull();

    const log = readFileSync(result.details.fullOutputPath!, "utf8");
    const fileLines = log.split("\n").length - (log.endsWith("\n") ? 1 : 0);
    const fileChars = log.length;
    expect(Number(note![2]), `the note counts ${note![2]} characters in a log that holds ${fileChars}`).toBeGreaterThanOrEqual(fileChars);
    expect(Number(note![5]), `the note counts ${note![5]} lines in a log that holds ${fileLines}`).toBeGreaterThanOrEqual(fileLines);
    // The traceback append is what makes the second count differ from the first, and it is in the file.
    expect(log, "the full traceback was not appended to the log the note counts").toContain("x".repeat(300_000));
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
