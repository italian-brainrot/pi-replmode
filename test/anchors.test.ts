import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The audit script's anchors are exact source text, so they rot the moment a fix moves the line they point
 * at — and a stale anchor is skipped *silently* by a real sweep, which turns "this fix is pinned" into an
 * untested claim. `ANCHORS_ONLY=1` catches them in seconds, but only when someone remembers to run it, so
 * the same check lives here, where it fails like any other test.
 *
 * Pass 6 found two of its own anchors rejected by the script's typecheck — a replacement that dropped a
 * closing backtick, and a guard neutered with `false &&` that broke the narrowing above it. Neither is
 * expressible as a substring check, so what this test pins is the half it can reach: every anchor still
 * matches, every file named is a file that exists, and no label is reused (the filter argument selects by
 * label, so a duplicate means one mutation can never be run alone).
 */

interface Mutation {
  label: string;
  file: string;
  anchor: string;
  replacement: string;
  spec: string;
}

/** One `run_mutation` call per entry, parsed out of the script rather than trusted from it. */
function parseMutations(script: string): Mutation[] {
  const calls = script.split("\nrun_mutation ").slice(1);
  const out: Mutation[] = [];
  for (const call of calls) {
    // One call is: "label"  file  'anchor ⏎ ---MUTATE--- ⏎ replacement'  "test/spec". The quoted block is
    // non-greedy because a bash single-quoted argument cannot contain a quote at all, so the first closing
    // quote is the real one — and the chunk runs on past the call into the next comment block, so the match
    // ends at the spec's newline rather than at the end of the chunk.
    const m = /^"([^"]*)"\s+(\S+)\s+'([\s\S]*?)'\s+"(test\/[^"]+)"\s*\n/.exec(call);
    if (!m) continue;
    const [, label, file, body, spec] = m;
    if (label === undefined || file === undefined || body === undefined || spec === undefined) continue;
    const split = "\n---MUTATE---\n";
    const at = body.indexOf(split);
    if (at < 0) continue;
    out.push({ label, file, anchor: body.slice(0, at), replacement: body.slice(at + split.length), spec });
  }
  return out;
}

describe("the mutation audit's anchors", () => {
  const script = readFileSync(new URL("../scripts/mutation-audit.sh", import.meta.url), "utf8");
  const mutations = parseMutations(script);
  const sources = new Map<string, string>();
  const sourceOf = (file: string): string => {
    if (!sources.has(file)) sources.set(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    return sources.get(file)!;
  };

  it("are all parsed, so this test is really checking the script", () => {
    // The script is the source of truth; if the parser stops matching its shape the test would silently
    // check nothing, so the count is pinned against what the script itself claims.
    const declared = (script.match(/^run_mutation "/gm) ?? []).length;
    expect(mutations.length, "every run_mutation call should parse").toBe(declared);
    expect(mutations.length).toBeGreaterThan(50);
  });

  it("name files that exist, with labels that single them out", () => {
    const labels = new Set<string>();
    for (const m of mutations) {
      // Whatever the mutation breaks has to exist: `src/*.ts` mostly, and once `README.md`, because a
      // sentence the model reads is as breakable as a line of code.
      expect(() => sourceOf(m.file), `mutation "${m.label}" names a file that is not there: ${m.file}`).not.toThrow();
      expect(() => sourceOf(m.spec), `mutation "${m.label}" names a test file that is not there: ${m.spec}`).not.toThrow();
      expect(labels.has(m.label), `label "${m.label}" is used twice: the filter can never select it alone`).toBe(false);
      labels.add(m.label);
    }
  });

  it("still match the source they point at", () => {
    const rotted: string[] = [];
    for (const m of mutations) {
      if (!sourceOf(m.file).includes(m.anchor)) rotted.push(`${m.label}  [${m.file}]  anchor: ${m.anchor.slice(0, 60)}`);
    }
    expect(rotted, `anchors no longer in the source — re-find them, do not delete the mutation:\n${rotted.join("\n")}`).toEqual([]);
  });

  it("change something: a replacement identical to its anchor breaks nothing and proves nothing", () => {
    const same = mutations.filter((m) => m.replacement === m.anchor).map((m) => m.label);
    expect(same, `mutations that leave the file as they found it:\n${same.join("\n")}`).toEqual([]);
  });
});
