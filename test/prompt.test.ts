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

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HistoryNote } from "../src/manager.ts";
import { channelFileStem } from "../src/names.ts";
import { lostChannelsLines } from "../src/prompt.ts";
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

  it("R5-06: and the reason it gives for the limit is one the code can actually back up", () => {
    // The rule is where pass 4 put it, and the wording of both copies blames the file names — the
    // parameter says a name is 200 characters at most "because it names the log and history files of
    // that channel", and the refusal adds "and an IPython profile". That is not what the code does.
    // `channelFileStem` keeps a name verbatim only while it is already a usable file name *and* no
    // longer than 40 characters; anything else gets a 10-character digest, so a name with a space in it
    // — at any length — and a name of 200 characters all become stems of at most 51 characters. The
    // daemon log, the history file and the IPython profile are the same length for a 4-character channel
    // and a 200-character one, so no name this tool refuses would have overflowed a path. The limit is
    // real, and its real reason is the one written above the refusal in `manager.ts`: the name is quoted
    // in results, in the history file, and in the prompt section of every later session. A wrong reason
    // on a model-facing surface is a model reasoning from a false premise.
    const parameters = ext.tools.get("run")!.parameters as { properties: { channel?: { description?: string } } };
    const description = parameters.properties?.channel?.description ?? "";

    // The fact the sentence gets wrong, pinned on its own: if stems ever do grow with the name, the
    // sentence becomes defensible and this assertion is the thing to change (with a note here).
    const stems = ["main", `n${"y".repeat(199)}`, `${"a".repeat(190)} spaced name`].map(channelFileStem);
    expect(
      Math.max(...stems.map((stem) => stem.length)),
      `a 200-character name produces a stem of ${Math.max(...stems.map((stem) => stem.length))} characters, so name length is not what file names are bounded by`,
    ).toBeLessThanOrEqual(51);

    // What is required of the sentence: name the reason that is true — the name comes back, in this
    // session's answers and in later sessions' prompts. (The exact words are the fixer's.)
    expect(description, `the description still credits file names for the limit: ${description}`).toMatch(
      /quoted|prompt|every later session|comes back/i,
    );
  });

  it("R5-06: and the refusal gives the model the same reason the parameter does", async () => {
    // Two copies of one rule, and pass 5 found them both wrong in the same way. The refusal is the copy
    // a model sees after it has already chosen a bad name, so a false reason there is paid for by a
    // call that has to be re-decided from scratch.
    const refused = await ext.callTool("run", { code: "print(1)", channel: "n".repeat(201) });
    expect(refused.isError).toBe(true);
    const shown = text2(refused);
    expect(shown, `the refusal credits something other than the model for the limit: ${shown}`).toMatch(
      /quoted|prompt|every later session|comes back/i,
    );
    expect(shown, `the refusal forbids a length the tool accepts: ${shown}`).not.toMatch(/under 200/);
  });
});

describe("a history record the section cannot read", () => {
  it("R5-03: a field of the wrong shape does not decide whether the session gets a prompt section", async () => {
    // The read path already distrusts the file: a record that is not an object is skipped, `status` and
    // `code` go through `quoted`, every remembered definition is coerced with `String(…)` before it is
    // clipped — that last one was a crash of exactly this shape, fixed in the pass-4 round for
    // `definitions: [1, 2]`. What is still enough to throw is `definitions` being a *string*: it has a
    // `length` and a `slice`, so it passes the truthiness test, and it has no `map`. One `TypeError` from
    // `lostChannelsLines` escapes `session_start` before `section` is assigned, and pi's handler loop
    // swallows it — so what a session gets is not a section with a bad line in it but no section at all
    // (or, in a process that rendered one before, the *previous* session's section, which is a different
    // kind of lie: it names channels that are no longer lost and omits the ones that are).
    const dir = historyDir();
    const record = (channel: string, extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({
        ts: "2026-01-03T00:00:00.000Z",
        id: `repl-${channel}`,
        channel,
        status: "completed",
        elapsed: 2.5,
        code: `${channel}_marker = 1`,
        ...extra,
      })}\n`;
    const files = [join(dir, "r5-good.jsonl"), join(dir, "r5-baddefs.jsonl")];
    try {
      writeFileSync(files[0]!, record("r5-good", { definitions: ["fine"] }), "utf8");
      writeFileSync(files[1]!, record("r5-baddefs", { definitions: "df" }), "utf8");

      // A second load of the extension in the same agent dir, i.e. what `/reload` does to the module while
      // the manager and its channels stay: this instance has never rendered a section, so it shows what a
      // session that starts against this history file gets.
      vi.resetModules();
      const fresh = await loadExtension({ agentDir: ext.agentDir });
      try {
        let thrown: string | undefined;
        try {
          await fresh.emit({ type: "session_start", reason: "startup" }, { hasUI: true });
        } catch (error) {
          // pi wraps every handler call in a try/catch and reports the error; the session goes on without
          // ever learning that the extension's section is missing.
          thrown = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        expect(thrown, "a remembered `definitions` field that is a string still throws out of session_start").toBeUndefined();

        const sections: Record<string, string> = {};
        await fresh.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: { sections } });
        const shown = sections.replmode ?? "";
        expect(shown, "the session got no replmode section at all").toContain("stateful IPython REPL");
        expect(shown, "the channel with a well-formed record is not reported").toContain("r5-good_marker");
        expect(shown, "the channel whose record has a string in `definitions` is not reported").toContain("r5-baddefs_marker");
      } finally {
        await fresh.emit({ type: "session_shutdown", reason: "quit" });
        fresh.dispose();
      }
    } finally {
      for (const file of files) rmSync(file, { force: true });
    }
  });

  it("R5-03: and a record whose rendering throws costs its own line, not the section", () => {
    // The shape guards cover the field shapes a JSON file can hold. This is the insurance behind them:
    // the note is built out of files this build did not necessarily write, so one record that defeats
    // every guard must still cost only its own line. A getter that throws stands in for a renderer that
    // meets a field shape it never anticipated — the case the guards above exist for.
    const note = (channel: string, extra: Record<string, unknown> = {}): HistoryNote =>
      ({
        ts: "2026-01-03T00:00:00.000Z",
        id: `repl-${channel}`,
        channel,
        status: "completed",
        elapsed: 1.5,
        code: `${channel}_marker = 1`,
        ...extra,
      }) as HistoryNote;
    const unreadable: HistoryNote = {
      ts: "2026-01-03T00:00:00.000Z",
      id: "repl-r5-unreadable",
      channel: "r5-unreadable",
      status: "completed",
      elapsed: 1.5,
      code: "r5-unreadable_marker = 1",
      // A getter, so the throw happens when the line is built rather than when the record is made.
      get definitions(): string[] {
        throw new TypeError("a field shape this renderer did not anticipate");
      },
    };

    const shown = lostChannelsLines([note("r5-readable"), unreadable]).join("\n");
    expect(shown, "a record that renders vanished along with the whole note").toContain("r5-readable_marker");
    expect(shown, "the record that could not be rendered is not reported as unreadable").toContain("could not read");
    expect(shown, "the unreadable record's channel is not named, so the note cannot be acted on").toContain("r5-unreadable");
    expect(shown, "the record next to the unreadable one lost its own wording").toContain("last cell completed in 1.5s");
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

  it("R4-08: and replaces the claim with the one that is true", () => {
    // Forbidding the false sentence is only half of it — the other half is that the replacement stays.
    // Without this, deleting the paragraph altogether would satisfy the test above and leave the README
    // silent about how big an answer can be, which is how the false claim got there in the first place.
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme, "the README no longer says what the 50 000 characters are spent on").toMatch(/output and its traceback together/i);
    expect(readme, "the README does not say that the notes around a cut are outside the limit").toMatch(/outside the budget/i);
    expect(readme, "the README does not admit that an answer can go over the limit").toMatch(/over 50 000/i);
  });
});
