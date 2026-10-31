/**
 * Channel names the model invents, and the file names they become.
 *
 * A channel name arrives from the model, and it is used three times: as the key of the live channel
 * map, as the daemon's log file, and as the history file. The last two are sanitised (`/`, `.`, and
 * anything else non-alphanumeric become `_`, then the name is cut at 40 characters), so two different
 * channel names can end up sharing a file — and the "these channels are gone" note compares the
 * *sanitised* name against the live map, where only the real name is a key.
 *
 * Tests whose comment names an issue id (R2-nn) document a defect from the pass-2 audit, and (R3-nn)
 * one from the pass-3 audit of those fixes.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getManager } from "../src/manager.ts";
import { channelFileStem } from "../src/names.ts";
import { type LoadedExtension, loadExtension, makeTempDir, text } from "./helpers/extension.ts";

const agent = makeTempDir("replmode-names-");

async function fresh(): Promise<LoadedExtension> {
  vi.resetModules();
  return loadExtension({ agentDir: agent.path, env: { PI_REPLMODE_MAX_CHANNELS: "12" } });
}

async function section(ext: LoadedExtension): Promise<string> {
  const sections: Record<string, string> = {};
  await ext.emit({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: { sections } });
  return sections.replmode ?? "";
}

describe("a channel whose name is not already a file name", () => {
  it("R2-04: is never announced to the model as a channel that was lost", async () => {
    const ext = await fresh();
    const started = await ext.callTool("run", { code: "prepared = load_data()\nprint('working in it')", channel: "n-slash/live" });
    expect(text(started)).toContain("[new channel");

    // A session boundary inside the same process (`/new`, `/resume`) re-renders the section. The
    // daemon is still running and `prepared` is still bound.
    await ext.emit({ type: "session_start", sessionId: "n-session" }, { hasUI: true });
    const shown = await section(ext);
    expect(shown, `a live channel was listed among the lost ones:\n${shown.split("\n").slice(-6).join("\n")}`).not.toContain("n-slash");
    expect(ext.notified.map((note) => note.message).join("\n"), "the notification lied about a live channel").not.toContain("n-slash");

    // Its state really is still there.
    const again = await ext.callTool("run", { code: "print(prepared)", channel: "n-slash/live" });
    expect(text(again)).not.toContain("[new channel");

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
  });
});

describe("the file names a channel name becomes", () => {
  it("R2-04: is one-to-one, so two channel names never share a daemon log, history file or profile", () => {
    const names = [
      "main",
      "a/b",
      "a_b",
      "a b",
      "a.b",
      "notes/live",
      "notes_live",
      "work-2",
      "work 2",
      "../../escape",
      "...",
      "x".repeat(60),
      `${"x".repeat(60)}-two`,
      "\u00e9clair",
      "clair",
    ];
    const stems = names.map((name) => channelFileStem(name));
    const collisions = stems.filter((stem, index) => stems.indexOf(stem) !== index);
    expect(collisions, `these channel names collapse onto one file name: ${collisions.join(", ")}`).toEqual([]);

    // …and none of them is a way out of the directory it is written into.
    for (const [index, stem] of stems.entries()) {
      expect(stem, `a stem for ${JSON.stringify(names[index])} is not a plain file name`).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(stem.startsWith(".")).toBe(false);
      expect(stem.length).toBeLessThanOrEqual(60);
    }
  });

  it("keeps a name that is already a file name exactly as it is", () => {
    // So the files for `main` — and the history files the tests and any user inspect by eye — stay
    // readable and stable, instead of every channel getting a digest it never asked for.
    for (const name of ["main", "data-loader", "t-hist", "a-b_C9"]) {
      expect(channelFileStem(name)).toBe(name);
    }
  });

  it("R3-03: stays one-to-one even when a name *is* the digested form of another name", () => {
    // The digest is appended with a `-`, which is a character a usable name may contain, so the digested
    // stem of one name is itself a name that is "already a usable file name" and is kept verbatim. Two
    // channels then share the daemon log, the history file and the IPython profile again — the exact
    // thing R2-04 was about, reachable by any model that copies a file name it saw back into `channel`.
    const stem = channelFileStem("r3-dig/x");
    expect(
      channelFileStem(stem),
      `the name "${stem}" maps to itself, so a channel called that and a channel called "r3-dig/x" share one set of files`,
    ).not.toBe(stem);
  });

  it("R3-03: and no stem this function produced is a name it would keep verbatim", () => {
    // The rule that makes the mapping injective is that a name which already looks digested never keeps
    // it. Checked over the names a session uses, over the stems they become, and over the stems of those
    // stems — a stem is exactly the string a model may copy back into `channel`, and none of them may
    // land on the same file or map to itself.
    const names = ["main", "a/b", "a_b", "r3-dig/x", "x".repeat(40), "work-2", "notes/live", "-r3-dash", "a-b_C9"];
    const stems = names.map((name) => channelFileStem(name));
    const digested = stems.filter((stem) => /-[0-9a-f]{10}$/.test(stem));
    expect(digested.length, "none of these names got a digest, so the test is not testing anything").toBeGreaterThan(0);

    for (const stem of digested) {
      expect(channelFileStem(stem), `the stem "${stem}" is a fixed point of the mapping`).not.toBe(stem);
    }
    const all = [...stems, ...digested.map((stem) => channelFileStem(stem))];
    const collisions = all.filter((entry, index) => all.indexOf(entry) !== index);
    expect(collisions, `two of these names collapse onto one file name: ${collisions.join(", ")}`).toEqual([]);
    for (const entry of all) {
      expect(entry, `a stem is not a plain file name: ${entry}`).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(entry.length, `a stem is longer than the 60 characters any stem must fit in: ${entry}`).toBeLessThanOrEqual(60);
    }
  });

  it("R3-03: keeps the history of two such channels apart, so neither is forgotten", async () => {
    const crafted = channelFileStem("r3-own/x");

    const first = await fresh();
    await first.callTool("run", { code: "slashed_marker = 1", channel: "r3-own/x" });
    await first.callTool("run", { code: "crafted_marker = 1", channel: crafted });
    await first.emit({ type: "session_shutdown", reason: "quit" });
    first.dispose();

    const files = readdirSync(join(agent.path, "replmode/history")).filter((entry) => entry.startsWith("r3-own"));
    expect(files.length, `the channels "r3-own/x" and "${crafted}" share one history file (${files.join(", ")})`).toBe(2);

    // One file, one record: the second channel took the first's place in the note, so a session that
    // starts later is told about one of the two channels and never about the other.
    const second = await fresh();
    await second.emit({ type: "session_start", sessionId: "r3-own-session" }, { hasUI: true });
    const shown = await section(second);
    expect(shown, `the note does not mention "r3-own/x":\n${shown.split("\n").slice(-8).join("\n")}`).toContain("r3-own/x");
    expect(shown).toContain(crafted);

    second.dispose();
  });
});

describe("a channel name that looks like a command-line option", () => {
  it("R3-02: still starts a channel", async () => {
    // The daemon is started as `-m replmode --channel <name> --log <path>`, and argparse refuses to
    // take a value that begins with a dash: the channel cannot start at all, and what reaches the model
    // is the daemon's usage message. The file-name encoder never emits a leading dash, so this is the
    // argument passing, not the naming.
    const ext = await fresh();
    const result = await ext.callTool("run", { code: "print('dash channel works')", channel: "-r3-dash" });
    const shown = text(result);
    // `toBeUndefined`, not `toBe(false)`: the tool's contract, pinned green by background.test.ts, is that
    // a successful result carries no `isError` at all (pi: "if provided, replaces the tool result error
    // flag"). Argued in "One test changed (pass 3 fixes)" in docs/AUDIT.md.
    expect(result.isError, `a channel named "-r3-dash" cannot be created: ${shown}`).toBeUndefined();
    expect(shown).toContain("dash channel works");

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
  });

  it("R3-02: and so do the names that are whole options", async () => {
    // `--channel=-x` and `--channel=--help` are one token each, so argparse cannot mistake the value for
    // another option. `--help` is the nastiest case: as a separate token it makes the daemon print its
    // usage onto the protocol fd and exit 0, which the host reads as a daemon speaking nonsense.
    const ext = await fresh();
    for (const name of ["-x", "--help", "-"]) {
      const result = await ext.callTool("run", { code: "print('started anyway')", channel: name });
      const shown = text(result);
      expect(result.isError, `a channel named ${JSON.stringify(name)} cannot be created: ${shown}`).toBeUndefined();
      expect(shown, `a channel named ${JSON.stringify(name)} did not run the cell: ${shown}`).toContain("started anyway");
    }

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
  });

  it("R3-03: keeps a 41-character name off the verbatim path, and a digested-looking one off it too", () => {
    // The verbatim rule has two conditions, and both need pinning at their boundary. A name that is
    // already a usable file name keeps it only while it is also short enough to survive the 40-character
    // readable part, and only while it does not look like a digest this function appended.
    const fortyOne = "a".repeat(41);
    expect(channelFileStem("a".repeat(40))).toBe("a".repeat(40));
    const digested = channelFileStem(fortyOne);
    expect(digested, "a 41-character name kept itself, so its files are named after a truncated form of it").not.toBe(fortyOne);
    expect(digested.startsWith("a".repeat(40))).toBe(true);
    expect(digested.length, `a stem for a long name is ${digested.length} characters`).toBeLessThanOrEqual(60);
    expect(channelFileStem("build-deadbeef00")).not.toBe("build-deadbeef00");
    // The regex only has to catch what this function can *emit*, not every string that looks digested:
    // eleven hex digits are not a digest this code appends, so that name may keep itself.
    expect(channelFileStem("x-00000000000")).toBe("x-00000000000");
  });

  it("R3-03: and every stem it appends a digest to is itself a name it refuses to keep verbatim", () => {
    // This is the whole injectivity argument in one property: every stem this function produces by the
    // digest branch matches `LOOKS_DIGESTED`, so it can never be a name that maps to itself — a fixed
    // point is unreachable by construction, not merely unlikely. Chained three deep (a stem of a stem of
    // a stem, which is what a model that copies file names out of results can build), no two links meet.
    // A name that keeps itself is the other branch, and chaining that is degenerate by design.
    const names = [
      "main",
      "a/b",
      "a_b",
      "éclair",
      "x".repeat(40),
      "x".repeat(41),
      "build-deadbeef00",
      "x-0000000000",
      "x-00000000000",
      "x-ABCDEF0123",
      "-r3-dash",
      "--help",
      "",
      "!!!",
      "a\0b",
    ];
    let digestBranches = 0;
    for (const name of names) {
      const first = channelFileStem(name);
      expect(first, `a stem is not a plain file name: ${first}`).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(first.length, `a stem is longer than the 60 characters any stem must fit in: ${first}`).toBeLessThanOrEqual(60);
      if (first === name) continue;

      digestBranches += 1;
      // Anything the digest branch emitted has to look digested: that is what makes the next step of the
      // chain refuse to keep it, and what stops two names meeting on one file.
      expect(first, `a stem this function appended a digest to does not look digested: ${first}`).toMatch(/-[0-9a-f]{10}$/);
      const chain = [name, first];
      for (let depth = 0; depth < 3; depth++) {
        const next = channelFileStem(chain[chain.length - 1]!);
        expect(next, `a stem maps to itself: ${chain.join(" -> ")}`).not.toBe(chain[chain.length - 1]);
        chain.push(next);
      }
      expect(new Set(chain).size, `two links of ${chain.join(" -> ")} name the same file`).toBe(chain.length);
    }
    expect(digestBranches, "none of these names went through the digest branch, so the test checks nothing").toBeGreaterThan(4);
  });

  it("R3-02: keeps a name that contains an option, a dash or an `=` whole, right through to `pi.channel`", async () => {
    // The name now travels as one argv token (`--channel=<name>`), which is what the file names and the
    // daemon's own copy of the name are derived from. Names that are themselves options, or that contain
    // `=`, are the ones argparse can mis-split: the daemon must record exactly what the model asked for,
    // because `pi.channel` and the `ready` frame are how the model sees the channel it is in.
    const ext = await fresh();
    for (const name of ["--", "--channel=x", "=", "-x=y", "a--b"]) {
      const result = await ext.callTool("run", { code: "import pi\nprint('NAME IS [' + pi.channel + ']')", channel: name });
      const shown = text(result);
      expect(result.isError, `a channel named ${JSON.stringify(name)} could not be created: ${shown}`).toBeUndefined();
      expect(shown, `the daemon recorded a different name than ${JSON.stringify(name)}: ${shown}`).toContain(`NAME IS [${name}]`);
    }

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
  });

  it("R4-02: does not report a live channel as lost because a record in its own file lost its name", async () => {
    // `lastHistoryByChannel` falls back to the *file stem* when a record has no usable `channel` field,
    // and `lostChannelNotes` then asks the live channel map with that stem. A stem is not a channel name
    // — that is exactly why R2-04 keyed the note by the record's own name — so a record that has lost its
    // name (hand-edited, truncated, or written by something that is not this program, all of which F3-04
    // already treats as possible) reports a running channel as gone, under a name it never had. And the
    // name it invents is a digested stem, which `run` now turns into a *third* channel if the model types
    // it back in (R3-03), so the note misleads twice.
    const name = "r4-stem/live";
    const stem = channelFileStem(name);
    const dir = join(agent.path, "replmode/history");
    mkdirSync(dir, { recursive: true });

    const ext = await fresh();
    const started = await ext.callTool("run", { code: "still_here = 1", channel: name });
    expect(text(started), "the channel did not start").toContain("[new channel");

    // The newest record in the channel's own history file, with its `channel` field missing.
    writeFileSync(
      join(dir, `${stem}.jsonl`),
      `${JSON.stringify({
        ts: new Date(Date.now() + 5 * 60_000).toISOString(),
        id: "repl-r4stem00",
        status: "completed",
        elapsed: 1,
        code: "r4_stem_marker = 1",
      })}\n`,
      "utf8",
    );

    await ext.emit({ type: "session_start", sessionId: "r4-stem" }, { hasUI: true });
    const shown = await section(ext);
    expect(shown, `a live channel was reported lost under its file stem:\n${shown.split("\n").slice(-6).join("\n")}`).not.toContain(stem);
    expect(ext.notified.map((note) => note.message).join("\n"), "the notification named a channel that is running").not.toContain(stem);

    // And the channel really is live with its variables, which is what the note tells the model is untrue.
    const again = await ext.callTool("run", { code: "print(still_here)", channel: name });
    expect(text(again), "the channel the note called lost is still there").not.toContain("[new channel");

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
  });
});

describe("a channel name that is not a sane length", () => {
  it("F3-02: is refused, because the name is kept and quoted for ever", async () => {
    // Fixer hardening in the class of R3-01: a channel name is not only a file name, it is pasted into
    // every result about that channel and, through the history file, into the prompt section of every
    // later session — where it is paid for on every request. Refusing is cheaper than quoting it.
    const ext = await fresh();
    const huge = `n${"z".repeat(500)}`;
    const result = await ext.callTool("run", { code: "print(1)", channel: huge });
    expect(result.isError, `a ${huge.length}-character channel name was accepted`).toBe(true);
    expect(text(result), `the refusal does not say what is wrong: ${text(result)}`).toContain("channel name");

    // Nothing about that name was written anywhere a later session would have to carry.
    await ext.emit({ type: "session_start", sessionId: "f3-02-name" }, { hasUI: true });
    const shown = await section(ext);
    expect(shown, "a refused channel name reached the prompt section").not.toContain("zzzz");

    // A name that is merely long is still fine — this is a guard, not a rename of the feature.
    const long = `n${"w".repeat(150)}`;
    const ok = await ext.callTool("run", { code: "print('a long name works')", channel: long });
    expect(text(ok)).toContain("a long name works");

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    ext.dispose();
  });
});

describe("a history file written before channel names got digests", () => {
  it("is still read, and its channel is still the one the model used", async () => {
    // The upgrade path R2-04 promises: old files keep their old names, and the note is keyed by the
    // record's own `channel`, which has always held the real name.
    mkdirSync(join(agent.path, "replmode/history"), { recursive: true });
    writeFileSync(
      join(agent.path, "replmode/history", "old_style.jsonl"),
      `${JSON.stringify({
        ts: new Date(Date.now() + 60_000).toISOString(),
        id: "repl-oldstyle",
        channel: "old/way",
        status: "completed",
        elapsed: 1,
        code: "legacy_marker = 1",
        definitions: ["legacy_marker"],
      })}\n`,
      "utf8",
    );

    const ext = await fresh();
    await ext.emit({ type: "session_start", sessionId: "r3-old-style" }, { hasUI: true });
    const shown = await section(ext);
    expect(shown, "a channel remembered under the old file name is not reported as lost").toContain("old/way");
    expect(shown).toContain("legacy_marker");

    ext.dispose();
  });

  it("R3-08: and when two files remember the same channel, the newest record is the one shown", () => {
    // Which happens on exactly that upgrade: `a/b` has an old `a_b.jsonl` and a new `a_b-<digest>.jsonl`.
    // The merge keeps one record per channel and whatever file the directory happened to return last
    // wins, so the model can be told about a cell from before the upgrade instead of the newest one.
    const dir = join(agent.path, "replmode/history");
    mkdirSync(dir, { recursive: true });
    const record = (code: string, ts: string) =>
      `${JSON.stringify({ ts, id: `repl-${code}`, channel: "r3-tie/break", status: "completed", elapsed: 1, code })}\n`;

    // Two rounds with the names swapped: whichever order the filesystem returns them in, one of the two
    // rounds puts the stale record last, and both rounds have to report the new one.
    const stale = record("stale_cell_marker = 1", "2026-01-01T00:00:00.000Z");
    const fresh = record("newest_cell_marker = 1", new Date(Date.now() + 120_000).toISOString());
    const rounds: Array<[string, string]> = [
      ["r3-tie-a.jsonl", "r3-tie-b.jsonl"],
      ["r3-tie-b.jsonl", "r3-tie-a.jsonl"],
    ];
    for (const [older, newer] of rounds) {
      writeFileSync(join(dir, older), stale, "utf8");
      writeFileSync(join(dir, newer), fresh, "utf8");
      const latest = getManager().lastHistoryByChannel().get("r3-tie/break");
      expect(
        latest?.code,
        `two files remember this channel and the record that won is not the newest (${older} is the stale one)`,
      ).toContain("newest_cell_marker");
    }
  });
});

describe("two channels whose names sanitise to one file", () => {
  it("R2-04: keep separate histories, so each one is remembered by the name it was given", async () => {
    const first = await fresh();
    await first.callTool("run", { code: "slashed_table = 1", channel: "n-coll/x" });
    await first.callTool("run", { code: "underscore_table = 1", channel: "n-coll_x" });
    await first.emit({ type: "session_shutdown", reason: "quit" });
    first.dispose();

    const names = readdirSync(join(agent.path, "replmode/history"));
    const second = await fresh();
    await second.emit({ type: "session_start", sessionId: "n-session-2" }, { hasUI: true });
    const shown = await section(second);

    // Both channels ran, both are gone now, and the model only ever knew them by these names.
    expect(shown).toContain("n-coll_x");
    expect(shown, `the slashed channel's history was merged into the other one's file (history files: ${names.join(", ")})`).toContain(
      "n-coll/x",
    );

    second.dispose();
  });
});
