/**
 * What the extension registers, and what it refuses to do.
 *
 * Displacing pi's built-in tools is the user's setting, not this extension's business, so the tool
 * set has to stay exactly three names and the runtime API calls exactly two. The same goes for the
 * system prompt: the extension contributes through the tool declarations and pi's guidelines list, and
 * writes no prompt section of its own.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emitPrompt, type LoadedExtension, loadExtension } from "./helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension();
});

afterAll(() => ext?.dispose());

describe("registration", () => {
  it("registers run, bg_wait and bg_stop and nothing else", () => {
    expect([...ext.tools.keys()].sort()).toEqual(["bg_stop", "bg_wait", "run"]);
  });

  it("never touches the active tool set and never uses a built-in name", () => {
    const touched = new Set(ext.calls.map((call) => call.prop));
    expect(touched.has("setActiveTools")).toBe(false);
    expect(touched.has("registerTool")).toBe(true);
    expect(touched.has("on")).toBe(true);
    const builtIns = ["bash", "read", "edit", "write", "grep", "find", "ls", "todowrite", "task"];
    for (const name of builtIns) expect(ext.tools.has(name), name).toBe(false);
  });

  it("runs calls in parallel so different channels overlap", () => {
    for (const name of ["run", "bg_wait", "bg_stop"]) {
      expect(ext.tools.get(name)?.executionMode, name).toBe("parallel");
    }
  });

  it("gives the model a description that states the contract", () => {
    const run = ext.tools.get("run")!;
    expect(run.description).toContain("stateful");
    expect(run.description).toContain("50000");
    for (const name of ["run", "bg_wait", "bg_stop"]) {
      expect(ext.tools.get(name)!.promptSnippet, name).toBeTruthy();
    }
    expect(run.promptGuidelines?.length).toBeGreaterThan(0);
  });

  it("documents the parameters the spec names", () => {
    const schema = ext.tools.get("run")!.parameters as { properties: Record<string, any>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["channel", "code", "timeout"]);
    expect(schema.required).toContain("code");
    expect(schema.properties.timeout?.description).toContain("background");
  });

  it("gives bg_stop an explicit escalation instead of killing silently", () => {
    const schema = ext.tools.get("bg_stop")!.parameters as { properties: Record<string, any> };
    expect(Object.keys(schema.properties).sort()).toEqual(["kill", "reason", "task_id"]);
    expect(schema.properties.kill.description).toContain("variables");
  });
});

describe("the prompt it asks pi for", () => {
  it("uses pi's own slots and writes no section of its own", async () => {
    // A `<replmode>` section was a block the extension put into the system prompt under a tag of its own
    // choosing, which pi then wrapped and replayed like any of its own sections. It is gone: the tool
    // declarations, the tools' `promptGuidelines`, and the session's own guidelines are the whole surface.
    const options = await emitPrompt(ext);
    expect(options.sections).toEqual({});
  });

  it("adds nothing to a prompt the user overrode with SYSTEM.md or --system-prompt", async () => {
    // `customPrompt` is how pi carries that. pi renders no preamble, tools, or rules section then, so the
    // snippets and guidelines registered on the tools are already out of it, and the extension's own
    // bullets stay out too.
    const options = await emitPrompt(ext, { customPrompt: "Say what I wrote and nothing else." });
    expect(options.promptGuidelines).toEqual([]);
    expect(options.sections).toEqual({});
  });

  it("is the same on every turn of one session, so the prompt cache survives", async () => {
    const first = await emitPrompt(ext);
    const second = await emitPrompt(ext);
    expect(second.promptGuidelines).toEqual(first.promptGuidelines);
  });

  it("survives a runtime that offers no prompt options at all", async () => {
    await expect(ext.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: undefined })).resolves.toBeDefined();
  });
});
