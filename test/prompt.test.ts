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
import { type LoadedExtension, loadExtension } from "./helpers/extension.ts";

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
