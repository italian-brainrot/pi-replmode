import { describe, expect, it } from "vitest";
import { formatDuration, nonceVarName, truncateMiddle } from "../src/format.ts";

function longText(lines: number, width = 10): string {
  return `${Array.from({ length: lines }, (_, i) => `${String(i).padStart(width, "0")}`).join("\n")}\n`;
}

describe("truncateMiddle", () => {
  it("leaves short text completely alone", () => {
    const cut = truncateMiddle("hello\nworld\n", 50_000);
    expect(cut.truncated).toBe(false);
    expect(cut.text).toBe("hello\nworld\n");
    expect(cut.totalLines).toBe(2);
  });

  it("keeps the head and the tail, and says what is missing", () => {
    const text = longText(10_000, 8);
    const cut = truncateMiddle(text, 50_000);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(50_000);
    expect(cut.headChars + cut.tailChars).toBeLessThanOrEqual(50_000);
    expect(cut.totalChars).toBe(text.length);
    expect(cut.text).toContain("characters and");
    expect(cut.text).toContain("not shown");
    expect(cut.text.startsWith("00000000\n")).toBe(true);
    expect(cut.text.endsWith(`${String(9999).padStart(8, "0")}\n`)).toBe(true);
  });

  it("cuts on line boundaries so a line is never split in half", () => {
    const text = longText(5000, 20);
    const cut = truncateMiddle(text, 1000);
    const shown = cut.text.split("[...")[0]!;
    for (const line of shown.split("\n")) {
      if (line === "") continue;
      expect(line).toHaveLength(20);
    }
    expect(cut.text).toContain(`\n${String(4999).padStart(20, "0")}\n`);
  });

  it("handles one line longer than the whole budget", () => {
    const text = "x".repeat(10_000);
    const cut = truncateMiddle(text, 1000);
    expect(cut.truncated).toBe(true);
    expect(cut.headChars).toBe(540);
    expect(cut.tailChars).toBe(360);
    expect(cut.text.length).toBeLessThanOrEqual(1000);
    expect(cut.text).toContain("characters and");
  });

  it("counts lines the way a reader would", () => {
    expect(truncateMiddle("a\nb\nc", 100).totalLines).toBe(3);
    expect(truncateMiddle("a\nb\nc\n", 100).totalLines).toBe(3);
    expect(truncateMiddle("", 100).totalLines).toBe(0);
  });
});

describe("nonce variable names", () => {
  it("are identifiers and do not repeat", () => {
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const name = nonceVarName();
      expect(name).toMatch(/^_out_[0-9a-f]{8}$/);
      names.add(name);
    }
    expect(names.size).toBeGreaterThan(190);
  });
});

describe("formatDuration", () => {
  it("is readable at every scale", () => {
    expect(formatDuration(0.023)).toBe("23ms");
    expect(formatDuration(1.5)).toBe("1.5s");
    expect(formatDuration(75)).toBe("1m15s");
    expect(formatDuration(3700)).toBe("1h01m");
  });
});
