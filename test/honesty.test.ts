/**
 * Whether what the tool reports matches what it promises.
 *
 * `run` declares an `outputSchema`, documents a 50 000 character limit, and returns a `details` object
 * other code reads. These tests hold every path — success, failure, interrupt, background, death, and
 * the plain refusals — to those promises, because a model or a wrapper program can only act on what it
 * is told.
 *
 * Tests whose comment names an issue id (R2-nn) document a defect from the pass-2 audit.
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

describe("the 50 000 character limit covers the whole answer", () => {
  it("R2-02: a cell that raises with an enormous message still fits", async () => {
    // The traceback is not part of the capture, so it is appended outside the truncation, and an
    // exception whose message carries data (the thing that failed to parse, the diff, the row) can be
    // arbitrarily long. pi does not cap a tool result, so whatever is returned lands in the context.
    const result = await run("raise ValueError('unparseable: ' + 'x' * 300000)", { channel: "h-traceback" });
    expect(result.isError).toBe(true);
    const shown = text(result);
    // (`.length`, because `expect(string).toBeLessThan(number)` is a TypeError in vitest and this
    // assertion therefore never ran at all — see "Pass 2 fixes" in docs/AUDIT.md. Same bound.)
    expect(shown.length, `the result is ${shown.length} characters: the traceback gets no share of the limit`).toBeLessThan(
      MAX_OUTPUT_CHARS + 5_000,
    );
    expect(shown).toContain("ValueError");
  });

  it("R2-02: keeps the whole traceback somewhere the model can still read", async () => {
    // Shortening a traceback is only honest if the whole thing is kept. The capture already has that
    // deal — log file plus a global to slice — so the traceback has to get the same treatment.
    const result = await run("raise ValueError('unparseable: ' + 'y' * 300000)", { channel: "h-traceback-reach" });
    const shown = text(result);
    expect(result.details.fullOutputPath, `no log path in a shortened result: ${shown.slice(-400)}`).toBeTruthy();
    expect(shown, "the result does not say where the full traceback is").toContain("full traceback:");

    const log = readFileSync(result.details.fullOutputPath!, "utf8");
    expect(log, "the full traceback is not in the log the result points at").toContain("y".repeat(300000));

    // The note has to describe the cut that was actually made: calling a head-and-tail cut "head only"
    // is the R1-09/R2-01 mistake in a new place (the real-pi smoke found it).
    const note = /traceback truncated: showing (\d+) of (\d+) characters at the start and (\d+) at the end/.exec(shown);
    expect(note, `no head-and-tail traceback note in: ${shown.slice(-500)}`).not.toBeNull();
    expect(Number(note![3]), "the traceback note leaves the reader with no tail").toBeGreaterThan(0);
    expect(Number(note![1]) + Number(note![3]), "the note claims nothing was cut").toBeLessThan(Number(note![2]));

    // And it is reachable from the next cell without re-running anything.
    expect(result.details.varName, "no global bound for a shortened traceback").toMatch(/^_out_/);
    const sliced = await run(`print('the log holds it all:', len(${result.details.varName}) > 300_000)`, {
      channel: "h-traceback-reach",
    });
    expect(text(sliced), "the bound global does not hold the whole text").toContain("the log holds it all: True");
  });

  it("R2-02: gives the traceback whatever the output did not use", async () => {
    // The share of the limit is a floor, not a ceiling. Cutting a traceback that fit comfortably is its
    // own kind of dishonesty, and the cell that raises with a row in its message usually printed
    // nothing else.
    const result = await run("raise ValueError('the whole row: ' + 'z' * 30000)", { channel: "h-traceback-share" });
    const shown = text(result);
    expect(shown).toContain("zzz");
    expect(shown, "the traceback was cut although the answer had room for it").not.toContain("traceback truncated");
    expect(shown.length, `the answer is ${shown.length} characters`).toBeLessThan(MAX_OUTPUT_CHARS);
  });

  it("a long traceback from ordinary code still fits", async () => {
    const result = await run("def rec(n):\n    if n == 0:\n        raise RuntimeError('bottom')\n    return rec(n - 1)\nrec(400)", {
      channel: "h-traceback",
    });
    expect(result.isError).toBe(true);
    expect(text(result).length).toBeLessThan(MAX_OUTPUT_CHARS + 5_000);
  });
});

describe("structuredContent against the schema the tool declares", () => {
  function problems(structured: Record<string, unknown> | undefined): string[] {
    const schema = ext.tools.get("run")!.outputSchema as {
      required?: string[];
      properties: Record<string, any>;
    };
    const found: string[] = [];
    const value = structured ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) found.push(`declares ${key} as required, and it is missing`);
    }
    const allowed: unknown[] = schema.properties.status?.anyOf?.map((entry: any) => entry.const) ?? [];
    if (!allowed.includes(value.status)) found.push(`status ${JSON.stringify(value.status)} is not one of ${allowed.join(", ")}`);
    return found;
  }

  it("R2-05: every answer matches the shape `run` declares", async () => {
    // Every path a `run` can take, including the ones that never reach a daemon.
    const background = await run("import time\ntime.sleep(3)", { channel: "h-schema3", timeout: 0 });
    const answers: Array<[string, any]> = [
      ["completed", await run("print('fine')", { channel: "h-schema1" })],
      ["failed", await run("1 / 0", { channel: "h-schema1" })],
      ["dead", await run("import os\nos._exit(4)", { channel: "h-schema2" })],
      ["background (timeout: 0)", background],
      // The channel the background cell is still holding.
      ["busy channel", await run("print('blocked')", { channel: "h-schema3" })],
      ["empty code", await run("   ", { channel: "h-schema4" })],
      ["impossible timeout", await run("print(1)", { channel: "h-schema4", timeout: -5 })],
      [
        "interrupted",
        await run("import time\nwhile True: time.sleep(0.1)", { channel: "h-schema6", timeout: 10 }, { signal: abortAfter(600) }),
      ],
    ];

    const reported: string[] = [];
    for (const [name, result] of answers) {
      const found = problems(result.structuredContent);
      if (found.length > 0) reported.push(`${name}: ${found.join("; ")}`);
    }
    expect(reported, `structuredContent does not match the declared outputSchema:\n${reported.join("\n")}`).toEqual([]);

    await ext.callTool("bg_wait", { timeout: 20 });
  });
});

function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
