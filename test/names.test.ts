/**
 * Channel names the model invents, and the file names they become.
 *
 * A channel name arrives from the model, and it is used three times: as the key of the live channel
 * map, as the daemon's log file, and as the history file. The last two are sanitised (`/`, `.`, and
 * anything else non-alphanumeric become `_`, then the name is cut at 40 characters), so two different
 * channel names can end up sharing a file — and the "these channels are gone" note compares the
 * *sanitised* name against the live map, where only the real name is a key.
 *
 * Tests whose comment names an issue id (R2-nn) document a defect from the pass-2 audit.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
