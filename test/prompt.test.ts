/**
 * The restart notification.
 *
 * Losing a channel's variables is the one thing about this design a model cannot see for itself, so
 * the spec asks for a notification: a fresh session is told which channels existed and what their
 * last cell looked like, and the note arrives as part of the prompt it starts with rather than as
 * something it has to remember from a chat message.
 *
 * One agent dir and one manager per test file (that is what one process means here), so the cases
 * run in the order they build up state.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LoadedExtension, loadExtension, repoRoot, text as text2 } from "./helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ env: { PI_REPLMODE_MAX_CHANNELS: "12" } });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
});

function historyDir(): string {
  const dir = join(ext.agentDir, "replmode", "history");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function section(): Promise<string> {
  const sections: Record<string, string> = {};
  // The handler mutates the sections it is given, exactly as pi passes them.
  await ext.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: { sections } });
  return sections.replmode ?? "";
}

describe("what the model is told about stopping a task and about the channel cap", () => {
  it("R2-10: the section covers bg_stop's escalation, what killing a channel costs, and the cap", async () => {
    // The guidelines push the separate-channels pattern, and the escape hatch for a wedged task is in a
    // parameter description the model may not re-read at the moment it needs it. Both belong where the
    // model looks first.
    const shown = await section();
    expect(shown, "the section never mentions the kill escalation").toContain("kill: true");
    expect(shown, "the section does not say what killing a channel takes down").toMatch(/servers, builds and subprocesses/);
    expect(shown, "the section does not say channels are capped").toMatch(/capped/);
    expect(shown, "the section does not say the idlest channel is retired with its variables").toMatch(
      /idlest .* is retired with its variables/,
    );
  });

  it("the tool's own guidelines carry the same two facts", () => {
    const guidelines = ext.tools.get("run")!.promptGuidelines ?? [];
    const joined = guidelines.join("\n");
    expect(joined).toMatch(/cap|capped/i);
    expect(joined).toMatch(/idlest/);
    expect(joined).toMatch(/kill: true/);
  });

  it("R2-09: the kill says what it cannot reach", () => {
    // The group kill is the promise; a child that left the group is the exception, and a model that is
    // told "this ends everything the cells started" will otherwise go on believing the port is free.
    const parameters = ext.tools.get("bg_stop")!.parameters as { properties: { kill?: { description?: string } } };
    const description = parameters.properties?.kill?.description ?? "";
    expect(description).toContain("servers");
    expect(description, "the kill is promised to reach things it cannot reach").toMatch(/process group/);
  });

  it("R3-06: the model-facing section carries that exception too", async () => {
    // The parameter description is the one place R2-09 wrote the exception down, and it is the place a
    // model is least likely to re-read at the moment it decides. The section is what it reads every
    // session, and its `kill: true` line still promises the unqualified version.
    const shown = await section();
    const killLine = shown
      .split("\n")
      .filter((line) => /kill|servers|subprocesses/.test(line))
      .join("\n");
    expect(killLine, "the section never mentions the kill escalation").toContain("kill: true");
    expect(killLine, `the section promises the kill reaches things it cannot reach: ${killLine}`).toMatch(/process group/);
  });

  it("R3-06: and so do the run guidelines, which repeat the promise in their own words", () => {
    const guidelines = ext.tools.get("run")!.promptGuidelines ?? [];
    const killGuideline = guidelines.find((line) => line.includes("kill: true")) ?? "";
    expect(killGuideline, "no guideline mentions the kill").toContain("channel");
    expect(killGuideline, `the guideline promises more than a group kill can deliver: ${killGuideline}`).toMatch(/process group/);
  });

  it("R2-10: the section stays byte-stable while channels come and go", async () => {
    // The only thing allowed to change it is a session boundary: pi diffs prompt sections against the
    // system message it is replaying, so a section that changes mid-session is written into the
    // transcript again and breaks the provider's prompt cache from there down.
    const before = await section();
    const task = await ext.callTool("run", { code: "import time\ntime.sleep(5)", channel: "p-stable", timeout: 0 });
    const during = await section();
    await ext.callTool("bg_stop", { task_id: task.details.id, kill: true });
    await ext.callTool("run", { code: "print(1)", channel: "p-stable-2" });
    const after = await section();

    expect(during, "creating a channel changed the section").toBe(before);
    expect(after, "killing a channel changed the section").toBe(before);
  });
});

describe("lost channels", () => {
  it("says nothing about them before any channel has run", async () => {
    const shown = await section();
    expect(shown).toContain("IPython REPL");
    expect(shown).not.toContain("earlier pi process");
    expect(ext.notified).toHaveLength(0);
  });

  it("reports a channel that ran in an earlier process, with its last cell", async () => {
    writeFileSync(
      join(historyDir(), "gone.jsonl"),
      `${JSON.stringify({
        ts: "2026-01-01T00:00:00.000Z",
        id: "repl-gone000",
        channel: "gone",
        status: "completed",
        elapsed: 3.5,
        code: "df = load_big_thing()",
        definitions: ["df"],
      })}\n`,
      "utf8",
    );

    await ext.emit({ type: "session_start", reason: "startup" }, { hasUI: true });
    const shown = await section();
    expect(shown).toContain("earlier pi process");
    expect(shown).toContain("gone");
    expect(shown).toContain("load_big_thing");
    expect(shown).toContain("defined: df");
    expect(ext.notified.some((note) => note.message.includes("gone") && note.message.includes("variables were lost"))).toBe(true);
  });

  it("does not report a channel this process is still running", async () => {
    writeFileSync(
      join(historyDir(), "live.jsonl"),
      `${JSON.stringify({
        ts: "2026-01-01T00:00:00.000Z",
        id: "repl-live000",
        channel: "live",
        status: "completed",
        elapsed: 0.1,
        code: "old = 1",
      })}\n`,
      "utf8",
    );
    await ext.callTool("run", { code: "live_marker = 1", channel: "live" });
    await ext.emit({ type: "session_start", reason: "startup" });
    expect(await section()).not.toContain("live");
  });

  it("R1-13: still reports a channel whose newest history record was torn by a crash", async () => {
    // An append that a crash cut short leaves a half-written last line. Reading only the last line
    // used to drop the channel from the note entirely, and the next record written to the file was
    // glued onto the torn one and became unreadable too.
    const path = join(historyDir(), "torn.jsonl");
    const intact = JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      id: "repl-torn001",
      channel: "torn",
      status: "completed",
      elapsed: 1.5,
      code: "half_built = load_thing()",
      definitions: ["half_built"],
    });
    writeFileSync(path, `${intact}\n{"ts": "2026-01-02T00:00:00.000Z", "id": "repl-torn002", "chan`, "utf8");

    await ext.emit({ type: "session_start", reason: "startup" }, { hasUI: true });
    const shown = await section();
    expect(shown, "a torn record lost the channel from the note").toContain("torn");
    expect(shown).toContain("half_built");
    expect(shown).toContain("unreadable record");

    // And the file is sealed before the next record is appended, so the newest one still parses.
    await ext.callTool("run", { code: "torn_fixed = 1", channel: "torn" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const newest = JSON.parse(lines.at(-1)!);
    expect(newest.code).toContain("torn_fixed");
    expect(newest.status).toBe("completed");
  });

  it("keeps the history file bounded so a long session cannot grow it without limit", async () => {
    const path = join(historyDir(), "big.jsonl");
    const filler = "x".repeat(200);
    const lines = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({
        ts: "2026-01-01T00:00:00.000Z",
        id: `repl-big${i}`,
        channel: "big",
        status: "completed",
        elapsed: 0.01,
        code: `cell_${i} = "${filler}"`,
      }),
    );
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    expect(statSync(path).size).toBeGreaterThan(512 * 1024);

    await ext.callTool("run", { code: "newest_cell_marker = 1", channel: "big" });

    const after = readFileSync(path, "utf8");
    expect(after.length).toBeLessThanOrEqual(512 * 1024 + 4096);
    expect(after).toContain("newest_cell_marker");
    expect(after).toContain("cell_3999");
    expect(after).not.toContain("cell_0 =");
    expect(
      after
        .trim()
        .split("\n")
        .every((line) => line.startsWith("{")),
    ).toBe(true);
  });
});

describe("the rule a channel name has to obey", () => {
  it("R4-07: tells the model the rule where it picks the name, not only when it breaks it", () => {
    // F3-02 added a refusal for names over 200 characters. It is a fair refusal, but the only place the
    // rule exists is the error message and a comment: the `channel` parameter description — what the
    // model is choosing against — says nothing about length, and neither does the section. A rule that
    // only exists when it fails is a rule the model trips over once per session.
    const parameters = ext.tools.get("run")!.parameters as { properties: { channel?: { description?: string } } };
    const description = parameters.properties?.channel?.description ?? "";
    expect(description, "the channel parameter says nothing about the name rules").toContain("channel");
    expect(description, "the channel parameter does not mention the length limit that makes a call fail").toMatch(/200|length|characters/);
  });

  it("R4-07: and states the boundary the refusal actually enforces", async () => {
    // The code accepts exactly 200 and refuses 201; the message says "Keep it under 200". The shape of
    // the sentence is free, but it must not forbid the length the tool accepts, and it has to name the
    // number that is really in force.
    const accepted = await ext.callTool("run", { code: "print('a name of exactly the limit')", channel: `n${"y".repeat(199)}` });
    expect(accepted.isError, `a 200-character channel name was refused: ${text2(accepted)}`).toBeUndefined();

    const refused = await ext.callTool("run", { code: "print(1)", channel: "n".repeat(201) });
    expect(refused.isError).toBe(true);
    const shown = text2(refused);
    expect(shown, "the refusal does not say which limit it is enforcing").toMatch(/200/);
    expect(shown, `the refusal forbids a length the tool accepts: ${shown}`).not.toMatch(/under 200/);
  });
});

describe("what the README promises about the output limit", () => {
  it("R4-08: does not claim the whole answer fits inside the limit", () => {
    // The suite has always allowed a `run` answer to ride a few thousand characters over 50 000, because
    // the banner, the truncation notes and the death notes are extra text around the cut (the `+5_000`
    // slack in limits.test.ts encodes that). The pass-3 bounding of those notes made them closer to true
    // and still not true — they are ~3 KB now — while the README says the limit "covers the whole answer,
    // the traceback included". Either make the answer actually fit, or say what the limit covers.
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme, "the README promises an answer no bigger than the limit, which no test holds").not.toMatch(
      /limit covers the whole answer/i,
    );
  });
});
