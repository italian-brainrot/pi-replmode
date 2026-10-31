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
    expect(result.isError, `a channel named "-r3-dash" cannot be created: ${shown}`).toBe(false);
    expect(shown).toContain("dash channel works");

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
