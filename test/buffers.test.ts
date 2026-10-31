/**
 * The host's bounded capture buffers, as pure arithmetic.
 *
 * The process-level suites cannot pin how much of a broken daemon's startup output survives: node hands
 * the capture pipe over in reads of at most 64 KB, and where those cuts fall is not the host's choice.
 * What *is* the host's choice is which bytes it keeps once the buffer is over budget — the whole-chunk
 * version of that emptied the buffer on one oversized chunk, which is how a chatty interpreter lost most
 * of its own complaint (R3-07). So the arithmetic gets its own pin, and the start-failure report gets a
 * process-level one in `lifecycle.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { keepNewest } from "../src/channel.ts";

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");
const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");

describe("the startup capture buffer", () => {
  it("keeps the newest bytes, so the line that says why the daemon died survives", () => {
    const noise = bytes("HEAD-NOISE ".repeat(100));
    const reason = bytes("ImportError: the real reason\n");
    const kept = keepNewest([noise, reason], 64);

    expect(kept.bytes).toBe(64);
    expect(kept.dropped).toBe(noise.length + reason.length - 64);
    expect(text(kept.chunks)).toContain("ImportError: the real reason");
  });

  it("trims a single oversized chunk instead of dropping it", () => {
    // This is the whole finding: the cap loop removed whole chunks, so one chunk bigger than the cap
    // evicted itself and left the host with an empty buffer about a daemon that had said a great deal.
    const one = bytes(`${"x".repeat(1000)}THE-END`);
    const kept = keepNewest([one], 64);

    expect(kept.bytes, "the buffer was emptied instead of trimmed").toBe(64);
    expect(kept.dropped).toBe(one.length - 64);
    expect(text(kept.chunks)).toBe(one.toString("utf8").slice(-64));
  });

  it("leaves a buffer that is under the cap exactly as it was", () => {
    const chunks = [bytes("a"), bytes("b")];
    const kept = keepNewest(chunks, 64);

    expect(kept.bytes).toBe(2);
    expect(kept.dropped).toBe(0);
    expect(kept.chunks).toEqual(chunks);
  });

  it("counts what it gave up on, whichever chunks the cut falls inside", () => {
    const kept = keepNewest([bytes("a".repeat(30)), bytes("b".repeat(30)), bytes("c".repeat(30))], 60);

    expect(kept.bytes).toBe(60);
    expect(kept.dropped).toBe(30);
    expect(text(kept.chunks)).toBe(`${"b".repeat(30)}${"c".repeat(30)}`);
  });
});
