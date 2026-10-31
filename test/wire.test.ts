import { describe, expect, it } from "vitest";
import { CaptureSplitter, sentinelFor, stripSentinels } from "../src/wire.ts";

interface Captured {
  bytes: string[];
  boundaries: string[];
}

function collect(): { splitter: CaptureSplitter; captured: Captured } {
  const captured: Captured = { bytes: [], boundaries: [] };
  const splitter = new CaptureSplitter(
    (chunk) => captured.bytes.push(chunk.toString("latin1")),
    (id) => captured.boundaries.push(id),
  );
  return { splitter, captured };
}

function feed(splitter: CaptureSplitter, stream: Buffer, chunkSize: number): void {
  for (let i = 0; i < stream.length; i += chunkSize) {
    splitter.push(stream.subarray(i, Math.min(i + chunkSize, stream.length)));
  }
}

describe("CaptureSplitter", () => {
  const stream = Buffer.concat([
    sentinelFor("repl-aaaa1111"),
    Buffer.from("first line\nsecond line\n"),
    sentinelFor("repl-aaaa1111"),
    sentinelFor("repl-bbbb2222"),
    Buffer.from("to stderr\n"),
    sentinelFor("repl-bbbb2222"),
  ]);

  it("keeps the bytes of each exec between its own sentinels", () => {
    const { splitter, captured } = collect();
    splitter.push(stream);
    expect(captured.boundaries).toEqual(["repl-aaaa1111", "repl-aaaa1111", "repl-bbbb2222", "repl-bbbb2222"]);
    expect(captured.bytes.join("")).toBe("first line\nsecond line\nto stderr\n");
  });

  it("reassembles sentinels that straddle any chunk boundary", () => {
    // A pipe splits wherever it likes, including in the middle of the marker itself.
    for (let size = 1; size <= 23; size++) {
      const { splitter, captured } = collect();
      feed(splitter, stream, size);
      expect(captured.boundaries.join(","), `chunk size ${size}`).toBe("repl-aaaa1111,repl-aaaa1111,repl-bbbb2222,repl-bbbb2222");
      expect(captured.bytes.join(""), `chunk size ${size}`).toBe("first line\nsecond line\nto stderr\n");
    }
  });

  it("emits leading output that arrives before any block opens", () => {
    const { splitter, captured } = collect();
    splitter.push(
      Buffer.concat([Buffer.from("startup warning\n"), sentinelFor("repl-cccc3333"), Buffer.from("cell\n"), sentinelFor("repl-cccc3333")]),
    );
    expect(captured.bytes[0]).toBe("startup warning\n");
    expect(captured.boundaries).toEqual(["repl-cccc3333", "repl-cccc3333"]);
  });

  it("does not treat ordinary output as a boundary", () => {
    const { splitter, captured } = collect();
    splitter.push(Buffer.from("PIRB and a NUL \x00 somewhere\n"));
    expect(captured.boundaries).toEqual([]);
    expect(captured.bytes.join("")).toBe("PIRB and a NUL \x00 somewhere\n");
    expect(splitter.drain()).toHaveLength(0);
  });

  it("reports a marker with an unusable id as an unknown boundary", () => {
    const { splitter, captured } = collect();
    splitter.push(Buffer.concat([Buffer.from([0x00, 0x1e]), Buffer.from("PIRB\x1eNot A Valid Id\n"), Buffer.from("more\n")]));
    expect(captured.boundaries).toEqual([""]);
    expect(captured.bytes.join("")).toBe("more\n");
  });

  it("waits for a marker whose id has not arrived yet, then completes it", () => {
    const { splitter, captured } = collect();
    const full = sentinelFor("repl-dddd4444");
    splitter.push(full.subarray(0, 4));
    splitter.push(full.subarray(4, 10));
    expect(captured.boundaries).toEqual([]);
    splitter.push(full.subarray(10));
    expect(captured.boundaries).toEqual(["repl-dddd4444"]);
    expect(captured.bytes.join("")).toBe("");
  });

  it("treats a prefix with no id within 256 bytes as ordinary output", () => {
    const { splitter, captured } = collect();
    splitter.push(Buffer.concat([sentinelFor("repl-eeee5555").subarray(0, 7), Buffer.from("x".repeat(300))]));
    expect(captured.boundaries).toEqual([]);
    expect(captured.bytes.join("").startsWith("\x00\x1ePIRB\x1e")).toBe(true);
  });

  it("drains what is still pending when the stream ends", () => {
    const { splitter, captured } = collect();
    splitter.push(Buffer.from("output\x00\x1ePIRB\x1erepl"));
    expect(captured.bytes.join("")).toBe("output");
    expect(splitter.drain().toString("latin1")).toBe("\x00\x1ePIRB\x1erepl");
  });
});

describe("stripSentinels", () => {
  it("removes markers from text that still contains them", () => {
    const text = `a\n${"\x00\x1ePIRB\x1erepl-eeee5555\n"}b\n`;
    expect(stripSentinels(text)).toBe("a\nb\n");
  });
});
