/**
 * What this extension puts in the prompt, and where it is allowed to put it.
 *
 * pi owns the system prompt. The extension's whole contribution goes into pi's own slots — the
 * descriptions and parameter descriptions of its three tools, the `promptGuidelines` those tools
 * register, and the bullets it appends to `options.promptGuidelines` for the one fact a description
 * cannot carry (which channels an earlier pi process left behind). There is no `<replmode>` section:
 * pi renders the prompt body itself and leaves its own preamble, tool list and rules out when the user
 * overrides the prompt, and an extension that wrote a section anyway would keep talking over a prompt
 * whose owner asked for their own words.
 *
 * One agent dir and one manager per test file (that is what one process means here), so the cases
 * run in the order they build up state. The prompt-surface cases come after the lost-channel ones,
 * because a contribution that should be absent is only worth checking when there is one to be absent.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HistoryNote } from "../src/manager.ts";
import { channelFileStem } from "../src/names.ts";
import { lostChannelGuidelines } from "../src/prompt.ts";
import { emitPrompt, type LoadedExtension, loadExtension, promptText, repoRoot, text as text2 } from "./helpers/extension.ts";

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

/** The session's own guidelines: what this extension appended to pi's rules for this turn. */
async function guidelines(): Promise<string[]> {
  const options = await emitPrompt(ext);
  return options.promptGuidelines as string[];
}

describe("lost channels", () => {
  it("says nothing about them before any channel has run", async () => {
    const shown = await promptText(ext);
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
    const listing = await promptText(ext);
    expect(listing).toContain("earlier pi process");
    expect(listing).toContain("gone");
    expect(listing).toContain("load_big_thing");
    expect(listing).toContain("defined: df");
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
    expect(await promptText(ext)).not.toContain("live");
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
    const listing = await promptText(ext);
    expect(listing, "a torn record lost the channel from the note").toContain("torn");
    expect(listing).toContain("half_built");
    expect(listing).toContain("unreadable record");

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

describe("where the extension is allowed to write in the prompt", () => {
  it("writes no prompt section of its own, under any prompt", async () => {
    // pi builds `preamble`, `tools` and `rules` itself and wraps every other key of `options.sections` in
    // a tag of that key's name. A section named `replmode` sat outside all of that: it survived a
    // `SYSTEM.md` override, and it was a block of instructions inside a prompt somebody else wrote.
    expect(await promptText(ext), "this file expects the lost-channel listing to be there").toContain("earlier pi process");
    const options = await emitPrompt(ext);
    expect(options.sections, "the extension wrote into pi's sections").toEqual({});
  });

  it("adds nothing at all when the prompt is overridden by SYSTEM.md or --system-prompt", async () => {
    // `customPrompt` is how pi carries both. With it set, pi renders no preamble, no tool list and no
    // rules, so the snippets and the guidelines registered on the tools are already out of the prompt;
    // the only thing left to decide is whether the session's own listing goes in, and the answer is that
    // the extension leaves the prompt alone.
    const listing = await promptText(ext);
    expect(listing, "this case needs a listing to withhold").toContain("load_big_thing");
    const options = await emitPrompt(ext, { customPrompt: "My prompt, my rules." });
    expect(options.promptGuidelines).toEqual([]);
    expect(options.sections).toEqual({});
    expect(options.appendSystemPrompt).toBe("");
  });

  it("still tells the user about lost channels when the prompt is overridden", async () => {
    // Withholding the prompt contribution is not the same as losing the information: the notification is
    // what the human reads, and it never went through the system prompt.
    const notified = ext.notified.map((note) => note.message).join("\n");
    expect(notified, "the restart notification stopped naming the lost channels").toContain("gone");
    // The listing is in the prompt of a default-prompt session, and not in an overridden one.
    expect(await promptText(ext), "the listing is missing from a session with the default prompt").toContain("load_big_thing");
    const options = await emitPrompt(ext, { customPrompt: "My prompt, my rules." });
    expect((options.promptGuidelines as string[]).join("\n"), "the listing leaked into an overridden prompt").not.toContain(
      "load_big_thing",
    );
  });

  it("carries the contract on the tool declarations, which are not part of the prompt body", () => {
    // `customPrompt` removes pi's own prompt sections, but an active tool is still declared to the model:
    // description, parameters, and the guidelines pi pulls in when the tool is active.
    for (const name of ["run", "bg_wait", "bg_stop"]) {
      expect(ext.tools.get(name)!.description, name).toBeTruthy();
      expect(ext.tools.get(name)!.promptSnippet, name).toBeTruthy();
    }
    expect(ext.tools.get("run")!.promptGuidelines?.length).toBeGreaterThan(0);
  });
});

describe("the listing stays put while the session works", () => {
  it("R2-10: does not change between turns, so the prompt cache survives", async () => {
    // pi diffs the prompt against the system message it is replaying, so rules that change mid-session
    // are written into the transcript again and break the provider's prompt cache from there down. The
    // only thing allowed to re-read history is a session boundary.
    const before = await guidelines();
    expect(before.length, "this case needs a listing to keep steady").toBeGreaterThan(0);
    const task = await ext.callTool("run", { code: "import time\ntime.sleep(5)", channel: "g-stable", timeout: 0 });
    const during = await guidelines();
    await ext.callTool("run", { code: "print(1)", channel: "g-stable-2" });
    await ext.callTool("bg_stop", { task_id: task.details.id, kill: true });
    const after = await guidelines();

    expect(during, "creating a channel changed the guidelines").toEqual(before);
    expect(after, "killing a channel changed the guidelines").toEqual(before);
  });

  it("does not grow a second copy of itself across turns", async () => {
    // `before_agent_start` runs once per agent run, not once per session, and pi hands every run a fresh
    // copy of its own options. The extension appends its bullets to that copy; if it appended to
    // something that outlived the run, every turn would add another listing.
    const first = await guidelines();
    const second = await guidelines();
    const third = await guidelines();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("survives a runtime that offers no prompt options at all", async () => {
    await expect(ext.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: undefined })).resolves.toBeDefined();
  });

  it("survives prompt options with no guidelines list in them", async () => {
    // pi always hands over normalized options, but the handler must not be the thing that decides that.
    const options = { cwd: "/test", customPrompt: undefined, sections: {} };
    await expect(ext.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: options })).resolves.toBeDefined();
    expect(Array.isArray((options as { promptGuidelines?: string[] }).promptGuidelines)).toBe(true);
  });
});

describe("the tool descriptions carry the contract and nothing else", () => {
  it("states the behaviour a model cannot guess: state, limits, background", () => {
    const description = ext.tools.get("run")!.description;
    expect(description).toContain("stateful");
    expect(description, "the description no longer says state survives between calls").toMatch(/still there|same Python process/);
    expect(description, "the description no longer states the output limit").toContain("50000");
    expect(description, "the description no longer says a timed-out cell keeps running").toMatch(/background/);
    expect(description, "the description no longer says a raising cell keeps its state").toMatch(/traceback/);
  });

  it("gives no recipes for Python, which the model already knows", () => {
    // `open(path).read()` and friends are trained-in idioms. Writing them down does not teach anything;
    // it nudges the model's own preferences about how to write Python, on every request, in a slot that
    // is meant for what this tool does.
    const surfaces = [
      ext.tools.get("run")!.description,
      ext.tools.get("bg_wait")!.description,
      ext.tools.get("bg_stop")!.description,
      ...(ext.tools.get("run")!.promptGuidelines ?? []),
      ...(ext.tools.get("bg_wait")!.promptGuidelines ?? []),
      JSON.stringify(ext.tools.get("run")!.parameters),
      JSON.stringify(ext.tools.get("bg_wait")!.parameters),
      JSON.stringify(ext.tools.get("bg_stop")!.parameters),
    ].join("\n");
    for (const recipe of ["open(path", "subprocess.run", "pathlib", "dir()", "%who_ls"]) {
      expect(surfaces, `a tool surface tells the model how to write Python: ${recipe}`).not.toContain(recipe);
    }
  });

  it("R2-10 and R3-06: and the guidelines carry what a model decides with", () => {
    // The cap, what retiring a channel costs, and the process-group exception — which has to be somewhere
    // a model reads every session, not only in a parameter description it may not re-open at the moment
    // it decides to kill a channel.
    const joined = (ext.tools.get("run")!.promptGuidelines ?? []).join("\n");
    expect(joined, "the guidelines do not say channels are capped").toMatch(/capped/);
    expect(joined, "the guidelines do not say the idlest channel is retired with its variables").toMatch(
      /idlest .* is retired with its variables/,
    );
    const killGuideline = joined.split("\n").find((line) => line.includes("kill: true")) ?? "";
    expect(killGuideline, "the guidelines never mention the kill escalation").toContain("channel");
    expect(killGuideline, `the guideline promises more than a group kill can deliver: ${killGuideline}`).toMatch(/process group/);
    expect(killGuideline, "the guidelines do not say what a kill takes down").toMatch(/servers|subprocesses/);
  });

  it("R2-09: the kill says what it cannot reach", () => {
    // The group kill is the promise; a child that left the group is the exception, and a model that is
    // told "this ends everything the cells started" will otherwise go on believing the port is free.
    const parameters = ext.tools.get("bg_stop")!.parameters as { properties: { kill?: { description?: string } } };
    const description = parameters.properties?.kill?.description ?? "";
    expect(description).toContain("servers");
    expect(description, "the kill is promised to reach things it cannot reach").toMatch(/process group/);
  });
});

describe("the rule a channel name has to obey", () => {
  it("R4-07: tells the model the rule where it picks the name, not only when it breaks it", () => {
    // F3-02 added a refusal for names over 200 characters. It is a fair refusal, but the only place the
    // rule existed was the error message and a comment: the `channel` parameter description — what the
    // model is choosing against — said nothing about length. A rule that only exists when it fails is a
    // rule the model trips over once per session.
    const parameters = ext.tools.get("run")!.parameters as { properties: { channel?: { description?: string } } };
    const description = parameters.properties?.channel?.description ?? "";
    expect(description, "the channel parameter says nothing about the name rules").toContain("channel");
    expect(description, "the channel parameter does not mention the length limit that makes a call fail").toMatch(/200|length|characters/);
  });

  it("R4-07: and states the boundary the refusal actually enforces", async () => {
    // The code accepts exactly 200 and refuses 201; the message said "Keep it under 200". The shape of
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
    // The rule is where pass 4 put it, and the wording of both copies blamed the file names — the
    // parameter said a name is 200 characters at most "because it names the log and history files of
    // that channel", and the refusal added "and an IPython profile". That is not what the code does.
    // `channelFileStem` keeps a name verbatim only while it is already a usable file name *and* no
    // longer than 40 characters; anything else gets a 10-character digest, so a name with a space in it
    // — at any length — and a name of 200 characters all become stems of at most 51 characters. The
    // daemon log, the history file and the IPython profile are the same length for a 4-character channel
    // and a 200-character one, so no name this tool refuses would have overflowed a path. The limit is
    // real, and its real reason is the one written above the refusal in `manager.ts`: the name is quoted
    // in results, in the history file, and in the prompt of every later session. A wrong reason on a
    // model-facing surface is a model reasoning from a false premise.
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
    // session's answers and in later sessions' prompt. (The exact words are the fixer's.)
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

describe("a history record the listing cannot read", () => {
  it("R5-03: a field of the wrong shape does not decide whether the session gets the listing", async () => {
    // The read path already distrusts the file: a record that is not an object is skipped, `status` and
    // `code` go through `quoted`, every remembered definition is coerced with `String(…)` before it is
    // clipped — that last one was a crash of exactly this shape, fixed in the pass-4 round for
    // `definitions: [1, 2]`. What was still enough to throw is `definitions` being a *string*: it has a
    // `length` and a `slice`, so it passes the truthiness test, and it has no `map`. One `TypeError` took
    // the whole listing with it, and pi wraps every handler call in a try/catch and reports the error
    // without the session noticing, so what a session got was no listing at all.
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
      // the manager and its channels stay: this instance has never been through a session boundary, so it
      // shows what a session that starts against this history file gets.
      vi.resetModules();
      const fresh = await loadExtension({ agentDir: ext.agentDir });
      try {
        let thrown: string | undefined;
        try {
          await fresh.emit({ type: "session_start", reason: "startup" }, { hasUI: true });
        } catch (error) {
          thrown = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        expect(thrown, "a remembered `definitions` field that is a string still throws out of session_start").toBeUndefined();

        const listing = await promptText(fresh);
        expect(listing, "the session got no listing at all").toContain("earlier pi process");
        expect(listing, "the channel with a well-formed record is not reported").toContain("r5-good_marker");
        expect(listing, "the channel whose record has a string in `definitions` is not reported").toContain("r5-baddefs_marker");
      } finally {
        await fresh.emit({ type: "session_shutdown", reason: "quit" });
        fresh.dispose();
      }
    } finally {
      for (const file of files) rmSync(file, { force: true });
    }
  });

  it("R5-03: and a record whose rendering throws costs its own bullet, not the listing", () => {
    // The shape guards cover the field shapes a JSON file can hold. This is the insurance behind them:
    // the listing is built out of files this build did not necessarily write, so one record that defeats
    // every guard must still cost only its own bullet. A getter that throws stands in for a renderer that
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

    const shown = lostChannelGuidelines([note("r5-readable"), unreadable]).join("\n");
    expect(shown, "a record that renders vanished along with the whole listing").toContain("r5-readable_marker");
    expect(shown, "the record that could not be rendered is not reported as unreadable").toContain("could not read");
    expect(shown, "the unreadable record's channel is not named, so the listing cannot be acted on").toContain("r5-unreadable");
    expect(shown, "the record next to the unreadable one lost its own wording").toContain("last cell completed in 1.5s");
  });
});

describe("what the README promises about the output limit", () => {
  it("R4-08: does not claim the whole answer fits inside the limit", () => {
    // The suite has always allowed a `run` answer to ride a few thousand characters over 50 000, because
    // the banner, the truncation notes and the death notes are extra text around the cut (the `+5_000`
    // slack in limits.test.ts encodes that). The pass-3 bounding of those notes made them closer to true
    // and still not true — they are ~3 KB now — while the README said the limit "covers the whole answer,
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
