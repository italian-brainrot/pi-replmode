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
    expect(shown, `the result is ${shown.length} characters: the traceback gets no share of the limit`).toBeLessThan(
      MAX_OUTPUT_CHARS + 5_000,
    );
    expect(shown).toContain("ValueError");
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
