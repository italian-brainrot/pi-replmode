/**
 * What the extension registers, and what it refuses to do.
 *
 * Displacing pi's built-in tools is the user's setting, not this extension's business, so the tool
 * set has to stay exactly three names and the runtime API calls exactly two.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension } from "./helpers/extension.ts";

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
    expect(run.promptSnippet).toBeTruthy();
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

describe("prompt section", () => {
  it("is offered under its own tag and explains the contract", async () => {
    const sections: Record<string, string> = {};
    await ext.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: { sections } });
    expect(sections.replmode).toBeTruthy();
    expect(sections.replmode).toContain("stateful IPython REPL");
    expect(sections.replmode).toContain("bg_stop");
    expect(sections.replmode).toContain("timeout");
    expect((sections.replmode ?? "").split("\n").length).toBeLessThan(40);
  });

  it("does not change between runs of one session, so the prompt cache survives", async () => {
    const first: Record<string, string> = {};
    const second: Record<string, string> = {};
    await ext.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: { sections: first } });
    await ext.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: { sections: second } });
    expect(second.replmode).toBe(first.replmode);
  });

  it("survives a runtime that offers no sections at all", async () => {
    await expect(ext.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: undefined })).resolves.toBeDefined();
  });
});
