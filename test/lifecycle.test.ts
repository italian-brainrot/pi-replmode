/**
 * Channels that misbehave at the edges of their life: a daemon that never becomes ready, one that
 * answers a cell and then dies on the way out, one that closes its own protocol stream.
 *
 * These need a daemon that does something the real one never does, so they spawn a stub interpreter:
 * a real process on the real pipes speaking part of the real protocol, chosen by pointing
 * `PI_REPLMODE_ENV_DIR` at a directory whose `bin/python` is a script. The host side is unchanged —
 * it is still `src/` talking over pipes — only the thing on the other end is simpler and untrustworthy.
 *
 * Tests whose comment names an issue id (R1-nn) document a defect from the audit of that pass. The
 * pass-3 audit of the pass-2 fixes uses the same stub-interpreter trick; its ids are R3-nn.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_OUTPUT_CHARS } from "../src/format.ts";
import { isPidAlive, type LoadedExtension, loadExtension, text, waitFor } from "./helpers/extension.ts";

let ext: LoadedExtension;

beforeAll(async () => {
  ext = await loadExtension({ env: { PI_REPLMODE_MAX_CHANNELS: "12" } });
});

afterAll(async () => {
  await ext?.emit({ type: "session_shutdown", reason: "quit" });
  ext?.dispose();
});

/** An environment directory that already exists, whose interpreter is the script we supply. */
function stubInterpreter(name: string, script: string): string {
  const dir = join(ext.agentDir, "stub-env", name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "python"), `#!/usr/bin/env python3\n${script}`, { mode: 0o755 });
  writeFileSync(join(dir, ".complete"), JSON.stringify({ hash: "000000000000", base: "python3", version: "3" }), "utf8");
  return dir;
}

function readyFrame(channel: string): string {
  return JSON.stringify({
    t: "ready",
    channel,
    pid: 0,
    ppid: 0,
    cwd: "/",
    python: "3.14.0",
    ipython: "9.0.0",
    startup_ms: 1,
    log: "-",
  });
}

/** Run one call with the stub in place, then put the real environment back. */
async function withStub<T>(name: string, script: string, extraEnv: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  process.env.PI_REPLMODE_ENV_DIR = stubInterpreter(name, script);
  for (const [key, value] of Object.entries(extraEnv)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const key of ["PI_REPLMODE_ENV_DIR", ...Object.keys(extraEnv)]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  }
}

describe("a daemon that never reports ready", () => {
  it("R1-11: fails the call, and takes the wedged interpreter and its children with it", async () => {
    // An interpreter that hangs on import, or a wedged environment build, used to mean a two minute
    // wait behind an unreadable timeout, and the process it had started stayed behind afterwards.
    const pidFile = join(ext.agentDir, "wedged.pid");
    const childFile = join(ext.agentDir, "wedged-child.pid");
    const script = `import os, subprocess, time
open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))
child = subprocess.Popen(["bash", "-c", "sleep 120"])
open(${JSON.stringify(childFile)}, "w").write(str(child.pid))
time.sleep(600)
`;

    const started = Date.now();
    const result = await withStub("wedged", script, { PI_REPLMODE_READY_TIMEOUT_MS: "1500" }, () =>
      ext.callTool("run", { code: "print(1)", channel: "l-wedged" }),
    );
    expect(Date.now() - started, "the ready timeout was not honoured").toBeLessThan(15_000);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("could not start");
    expect(text(result)).toContain("did not report ready within 1.5s");

    await waitFor(() => existsSync(pidFile), 10_000, "the stub to record its pid");
    const stubPid = Number(readFileSync(pidFile, "utf8"));
    const childPid = Number(readFileSync(childFile, "utf8"));
    await waitFor(() => !isPidAlive(stubPid), 10_000, "the wedged stub interpreter to be taken down");
    await waitFor(() => !isPidAlive(childPid), 10_000, "the wedged stub's own child to be taken down");
  });
});

describe("a channel that never comes up, and what it says about itself", () => {
  it("R4-03: a daemon that never becomes ready still has to say why, or point at its output", async () => {
    // R3-07's fix writes the interpreter's complaint into the daemon's log path and points the failed
    // start at it — but it hangs off `reportStartFailure`, which only ever runs when the process exits,
    // and then only writes a file when the explanation was long enough to cut. A daemon that is alive
    // and never ready is answered by the ready timeout instead: the call is refused while the complaint
    // sits in the host's `loose` buffer, and the daemon is only group-killed afterwards. Observed at
    // HEAD: the answer is the bare timeout, nothing is written for a short complaint, and for a long
    // one the log file appears about half a second after the answer — a file no one names. The one
    // start failure the model can least do something about is the one that says nothing about why.
    const script = `import sys, time
sys.stderr.write("ImportError: the IPython history database is locked by another process\\n")
sys.stderr.flush()
time.sleep(600)
`;
    const result = await withStub("wedged-and-talking", script, { PI_REPLMODE_READY_TIMEOUT_MS: "1500" }, () =>
      ext.callTool("run", { code: "print(1)", channel: "l-wedge-says-why" }),
    );
    expect(result.isError).toBe(true);
    const shown = text(result);
    expect(shown).toContain("did not report ready");

    // The bytes are not necessarily lost (a complaint over the 3 000-character cut does end up in the
    // daemon's log path, about half a second after the answer was given) — so this is only about
    // whether the model is told. Either the reason is in the answer, or the answer names a file that
    // holds it.
    expect(shown, `a wedged daemon that explained itself is reported as a bare timeout: ${shown}`).toContain("history database is locked");
  });

  it("R3-07: and two failed starts on one name both leave their complaint in the file they point at", async () => {
    // The pointer has to be true for the *second* failure too. The host appends (it does not truncate),
    // so the file the second answer names holds both attempts — nothing is lost, and the newest
    // complaint is in it. Pinned here because a future "cleanup" that truncates would throw away the
    // first failure, and one that writes per-attempt files would break the pointer the answer gives.
    const counter = join(ext.agentDir, "twice-failed.count");
    // Long enough that each answer has to be cut and has to point at a file: a short complaint fits in
    // the answer whole and needs no pointer (the other branch, pinned by the R2-06 tests above).
    const script = `import os, sys
path = ${JSON.stringify(counter)}
attempt = 0
if os.path.exists(path):
    with open(path) as handle:
        attempt = int(handle.read())
with open(path, "w") as handle:
    handle.write(str(attempt + 1))
sys.stderr.write(("FAIL-%d-MARKER" % (attempt + 1)) + ("x" * 4000) + "\\n")
sys.stderr.flush()
sys.exit(1)
`;
    const pointers: string[] = [];
    for (const marker of ["FAIL-1-MARKER", "FAIL-2-MARKER"]) {
      const result = await withStub("twice-failed", script, {}, () => ext.callTool("run", { code: "print(1)", channel: "l-twice" }));
      expect(result.isError, `the ${marker} attempt did not fail`).toBe(true);
      const shown = text(result);
      expect(shown, `the ${marker} answer does not point at a file: ${shown.slice(-300)}`).toContain("full output is in");
      const pointer = /full output is in ([^\]]+)\]/.exec(shown)?.[1];
      expect(pointer, `the ${marker} answer names no file: ${shown.slice(-300)}`).toBeTruthy();
      pointers.push(pointer!);
      expect(readFileSync(pointer!, "utf8"), `the file named by the ${marker} answer does not hold ${marker}`).toContain(marker);
    }
    expect(pointers[1], "the two failed starts on one channel name wrote different files").toBe(pointers[0]);
    const saved = readFileSync(pointers[0]!, "utf8");
    expect(saved, "the second failed start overwrote the first one's complaint in the file it points at").toContain("FAIL-1-MARKER");
    expect(saved, "the second failed start did not leave its own complaint in the file it points at").toContain("FAIL-2-MARKER");
  });
});

describe("a daemon that answers a cell and then dies", () => {
  it("R1-06: is never reported as an ordinary completed call", async () => {
    // The `exec_end` frame and the process's death arrive on different channels with no ordering. A
    // daemon that got the frame out on its way out (a segfault in the epilogue, a cell that closed
    // the descriptors the daemon needs) used to come back as a plain success, and the next call
    // quietly started a fresh channel.
    const script = `import json, os, sys, time
sys.stdout.write(${JSON.stringify(`${readyFrame("l-dying")}\n`)})
sys.stdout.flush()
line = sys.stdin.readline()
frame = json.loads(line)
sys.stdout.write(json.dumps({"t": "exec_end", "id": frame["id"], "ok": True, "status": "ok", "elapsed": 0.01}) + "\\n")
sys.stdout.flush()
time.sleep(0.3)
os._exit(3)
`;

    const result = await withStub("dying", script, {}, () => ext.callTool("run", { code: "pretend = 1", channel: "l-dying" }));
    expect(result.details.status, "the call claims success over a dead channel").not.toBe("completed");
    expect(result.isError).toBe(true);
    const shown = text(result);
    expect(shown, shown.slice(0, 400)).toMatch(/ended|gone/);
    expect(shown).toContain("variables are lost");
  });
});

describe("a channel that cannot start at all", () => {
  it("R2-06: passes on what the daemon said about why", async () => {
    // The daemon goes out of its way to send a `fatal` frame when it knows the reason (no IPython, a
    // shell that failed to build). The model has to be told that, not just that the process ended: the
    // alternative is being handed an exit code and nothing to act on.
    const script = `import sys
sys.stdout.write(${JSON.stringify('{"t":"fatal","error":"IPython is not installed in this environment","traceback":"ImportError: no module named IPython"}')} + "\\n")
sys.stdout.flush()
sys.exit(1)
`;
    const result = await withStub("fatal-startup", script, {}, () => ext.callTool("run", { code: "print(1)", channel: "l-fatal" }));
    expect(result.isError).toBe(true);
    const shown = text(result);
    expect(shown, `the daemon's own explanation never reached the model: ${shown}`).toContain("IPython is not installed");
  });

  it("R2-06: keeps the interpreter's own complaint when it dies before speaking", async () => {
    // A cache directory left behind by an upgraded Python produces an interpreter that fails on import
    // and writes a traceback to the capture stream. `Channel.startupOutput()` exists for exactly this
    // case, and it is only ever read after `flushLoose()` has emptied the buffer it reads from.
    const script = `import sys
sys.stderr.write("Traceback (most recent call last):\\n  File \\"<frozen app>\\", line 1, in <module>\\nImportError: the environment is broken\\n")
sys.exit(1)
`;
    const result = await withStub("silent-crash", script, {}, () => ext.callTool("run", { code: "print(1)", channel: "l-crash" }));
    expect(result.isError).toBe(true);
    const shown = text(result);
    expect(shown, `an interpreter that said why it failed is reported as a bare exit code: ${shown}`).toContain(
      "the environment is broken",
    );
  });

  it("R2-06: keeps a very chatty broken interpreter inside the output limit", async () => {
    // The explanation is worth showing, and the daemon's `loose` buffer holds up to 64 KB of it. Forward
    // all of that into a tool result and the one promise the limit makes is broken by a failed start.
    const script = `import sys
sys.stderr.write("FLOOD " * 40000)
sys.stderr.write("\\nImportError: the environment is broken at the end\\n")
sys.exit(1)
`;
    const result = await withStub("loud-crash", script, {}, () => ext.callTool("run", { code: "print(1)", channel: "l-loud" }));
    expect(result.isError).toBe(true);
    const shown = text(result);
    expect(shown.length, `a failed start returned ${shown.length} characters`).toBeLessThan(MAX_OUTPUT_CHARS);
    expect(shown, "the reason at the end of a long startup failure was cut away").toContain("the environment is broken at the end");
    expect(shown, "the result does not say where the rest of it is").toContain("the daemon's full output is in");
  });

  it("leaves nothing running when the ready timeout fires on an environment that is fine", async () => {
    // A one-millisecond ready timeout can only ever lose the race with a real interpreter; what matters
    // is that the attempt is reaped and the next call starts clean.
    const result = await ext.callTool("run", { code: "print(1)", channel: "l-fastready" }, {});
    const saved = process.env.PI_REPLMODE_READY_TIMEOUT_MS;
    process.env.PI_REPLMODE_READY_TIMEOUT_MS = "1";
    try {
      const failed = await ext.callTool("run", { code: "print(1)", channel: "l-fastready-2" });
      expect(failed.isError).toBe(true);
      expect(text(failed)).toContain("did not report ready");
    } finally {
      if (saved === undefined) delete process.env.PI_REPLMODE_READY_TIMEOUT_MS;
      else process.env.PI_REPLMODE_READY_TIMEOUT_MS = saved;
    }
    const retry = await ext.callTool("run", { code: "print('the channel is fine after a lost race')", channel: "l-fastready" });
    expect(text(retry)).toContain("the channel is fine after a lost race");
    void result;
  });
});

describe("a channel that could not start, and what it promises about the rest", () => {
  it("R3-07: does not send the model to a daemon log that does not hold the daemon's output", async () => {
    // A cut-off explanation has to point somewhere that actually has the rest. The daemon's log file is
    // opened by the daemon itself, and the complaint that reaches the host arrived on the *capture*
    // stream, which is never written to that log: for an interpreter that dies before the daemon module
    // runs, the file the answer promises does not exist, and the middle of the complaint — dropped by
    // the 64 KB loose buffer — is nowhere at all.
    const script = `import sys
for i in range(600):
    sys.stderr.write("noise-%d " % i)
    if i == 300:
        sys.stderr.write("THE-MIDDLE-OF-THE-COMPLAINT ")
sys.stderr.write("\\nImportError: broken at the end\\n")
sys.stderr.flush()
sys.exit(1)
`;
    const result = await withStub("loud-and-pointless", script, {}, () => ext.callTool("run", { code: "print(1)", channel: "l-pointer" }));
    expect(result.isError).toBe(true);
    const shown = text(result);
    expect(shown.length, `a failed start returned ${shown.length} characters`).toBeLessThan(MAX_OUTPUT_CHARS);
    expect(shown, "the reason at the end of the complaint was cut away").toContain("ImportError: broken at the end");

    const pointer = /full output is in ([^\]]+)\]/.exec(shown)?.[1];
    expect(pointer, `the explanation was cut and nothing says where the rest is: ${shown.slice(-300)}`).toBeTruthy();
    expect(existsSync(pointer!), `the answer says the whole thing is in ${pointer}, which does not exist`).toBe(true);
    expect(readFileSync(pointer!, "utf8"), `the file the answer points at does not hold the middle of the complaint`).toContain(
      "THE-MIDDLE-OF-THE-COMPLAINT",
    );
  });

  it("R3-07: trims the startup buffer to its cap instead of dropping whole chunks", async () => {
    // The buffer that holds capture from before the first block is 64 KB, and a broken interpreter can
    // write far more than that. The host used to give up whole chunks, so an 80 KB complaint lost its
    // first 40 KB and the model was told a bigger number than the loss it suffered. Two 40 KB writes,
    // the first with a marker at byte 30 000: trimming keeps the last 64 KB and reports the bytes over
    // the cap, and the marker survives. This is also the safe direction to pin it in — if the pipe
    // happens to hand the bytes over in finer pieces, both versions keep the same bytes and this passes.
    const first = `${"a".repeat(29_999)}MARKER-AT-30000${"a".repeat(9_985)}`;
    const script = `import sys, time
sys.stderr.write(${JSON.stringify(first)})
sys.stderr.flush()
time.sleep(0.3)
sys.stderr.write("b" * 40_000)
sys.stderr.write("\\nImportError: broken at the end\\n")
sys.stderr.flush()
sys.exit(1)
`;
    const result = await withStub("trim-the-buffer", script, {}, () => ext.callTool("run", { code: "print(1)", channel: "l-trim" }));
    const shown = text(result);
    expect(result.isError).toBe(true);
    expect(shown, "the reason at the end of the complaint was cut away").toContain("ImportError: broken at the end");

    const note = /(\d+) bytes from the middle of that output were dropped/.exec(shown);
    expect(note, `the answer does not say how much was given up: ${shown.slice(-400)}`).not.toBeNull();
    const dropped = Number(note![1]);
    expect(
      dropped,
      `the host gave up ${dropped} bytes of an ${first.length + 40_030} byte complaint; only ${first.length + 40_030 - 65_536} are over the cap`,
    ).toBeLessThan(20_000);

    const pointer = /full output is in ([^\]]+)\]/.exec(shown)?.[1];
    expect(pointer, "the answer says nothing about where the rest is").toBeTruthy();
    const saved = readFileSync(pointer!, "utf8");
    expect(saved, "the file the answer points at lost the part of the complaint that should have survived").toContain("MARKER-AT-30000");
    expect(saved.length, "the saved output is not bounded by the buffer cap").toBeLessThan(70_000);
  });

  it("R2-06: keeps the exit code when the complaint comes late, from something the daemon left behind", async () => {
    // `exit` can beat the last of the pipes, and a process the daemon spawned keeps the capture stream
    // open after the daemon is gone. The report is bounded by `STDIO_DRAIN_MS` on purpose; what must
    // never be lost is the exit status, and what must never happen is the call waiting on that pipe.
    const childFile = join(ext.agentDir, "late-complaint-child.pid");
    const script = `import os, subprocess, sys
subprocess.Popen(["bash", "-c", "sleep 3; echo 'the real reason is in the child' 1>&2"], stdin=subprocess.DEVNULL)
open(${JSON.stringify(childFile)}, "w").write(str(os.getpid()))
sys.stderr.flush()
os._exit(4)
`;
    const started = Date.now();
    const result = await withStub("late-complaint", script, {}, () => ext.callTool("run", { code: "print(1)", channel: "l-late" }));
    expect(Date.now() - started, "the start failure waited for a pipe a leftover process was holding open").toBeLessThan(2_000);
    expect(result.isError).toBe(true);
    const shown = text(result);
    expect(shown, `a late writer cost the answer its exit code: ${shown}`).toContain("exit code 4");

    const stubPid = Number(readFileSync(childFile, "utf8"));
    await waitFor(() => !isPidAlive(stubPid), 10_000, "the stub to be reaped after the failed start");
  });

  it("R2-06: a fatal frame followed by a real ready does not make the channel look broken", async () => {
    // `fatalNote` is kept for the start-failure report. A daemon that sends one and then comes up anyway
    // must not have that text served to the model as the reason for a call that worked.
    const script = `import json, sys
sys.stdout.write(${JSON.stringify('{"t":"fatal","error":"a spurious complaint from an early attempt"}')} + "\\n")
sys.stdout.flush()
sys.stdout.write(${JSON.stringify(`${readyFrame("l-latefatal")}\n`)})
sys.stdout.flush()
while True:
    frame = json.loads(sys.stdin.readline())
    if frame.get("t") != "execute":
        break
    sys.stdout.write(json.dumps({"t": "exec_end", "id": frame["id"], "ok": True, "status": "ok", "elapsed": 0.01}) + "\\n")
    sys.stdout.flush()
`;
    const result = await withStub("fatal-then-ready", script, {}, () => ext.callTool("run", { code: "print(1)", channel: "l-latefatal" }));
    expect(result.isError, `a channel that answered was reported as broken: ${text(result)}`).not.toBe(true);
    expect(text(result), "a stale fatal frame was pasted into a call that worked").not.toContain("spurious complaint");

    const again = await ext.callTool("run", { code: "print('the channel is still usable')", channel: "l-latefatal" });
    expect(again.isError, `the channel stopped answering after its fatal frame: ${text(again)}`).not.toBe(true);
    expect(again.details.status).toBe("completed");
    await ext.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("R2-03: a channel whose daemon dies on the way up gives its slot straight back", async () => {
    // The cap counts creations that have not finished. If a failed one did not release its slot, the
    // next channel would be refused for the rest of the session by a process that no longer exists.
    const script = `import sys
sys.stdout.write(${JSON.stringify('{"t":"fatal","error":"cannot import IPython"}')} + "\\n")
sys.stdout.flush()
sys.exit(1)
`;
    const saved = process.env.PI_REPLMODE_MAX_CHANNELS;
    process.env.PI_REPLMODE_MAX_CHANNELS = "1";
    try {
      const failed = await withStub("slot-back", script, {}, () => ext.callTool("run", { code: "print(1)", channel: "l-slotfail" }));
      expect(failed.isError).toBe(true);
      const retry = await ext.callTool("run", { code: "print('room after a failed start')", channel: "l-slotok" });
      expect(text(retry), `a dead failed daemon still occupies the only slot: ${text(retry)}`).toContain("room after a failed start");
    } finally {
      if (saved === undefined) delete process.env.PI_REPLMODE_MAX_CHANNELS;
      else process.env.PI_REPLMODE_MAX_CHANNELS = saved;
    }
  });
});

describe("the channel cap while a channel is still starting", () => {
  it("R3-04: a session with nothing running does not claim all its channels are busy", async () => {
    // A creation occupies a slot (R2-03), which is right, but the refusal it produces reads as though
    // the session had cells in flight: "all 1 channels are busy … stop one with bg_stop". There is no
    // task to stop — `bg_stop` has no id to take — and the thing that is actually happening is that a
    // daemon has not come up yet, which the model's own options are "wait" or "kill that channel".
    const pidFile = join(ext.agentDir, "starting-occupier.pid");
    const script = `import os, time
open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))
time.sleep(600)
`;
    const saved = process.env.PI_REPLMODE_MAX_CHANNELS;
    process.env.PI_REPLMODE_MAX_CHANNELS = "1";
    try {
      await withStub("starting-occupier", script, { PI_REPLMODE_READY_TIMEOUT_MS: "4000" }, async () => {
        const occupier = ext.callTool("run", { code: "print(1)", channel: "l-occupier" });
        await waitFor(() => existsSync(pidFile), 15_000, "the starting daemon to record its pid");

        const refused = await ext.callTool("run", { code: "print(2)", channel: "l-refused" });
        // Settle the wedged call before asserting anything, so a red run cannot leave it behind.
        const failed = await occupier;
        const occupierPid = Number(readFileSync(pidFile, "utf8"));
        await waitFor(() => !isPidAlive(occupierPid), 15_000, "the daemon that never became ready to be reaped");

        expect(refused.isError).toBe(true);
        expect(failed.isError).toBe(true);
        const shown = text(refused);
        expect(shown, `the refusal blames busy channels when the only occupier is still starting: ${shown}`).toMatch(/starting|coming up/);
        // Say which one, and do not claim busy-ness that does not exist: "all N channels are busy" in a
        // session with nothing running sends the model to `bg_stop` with no task to stop.
        expect(shown, `the refusal still claims channels are busy when nothing is running: ${shown}`).not.toMatch(/are busy/);
        expect(shown, `the refusal does not name the channel holding the slot: ${shown}`).toContain("l-occupier");
        expect(shown).toContain("PI_REPLMODE_MAX_CHANNELS");
      });
    } finally {
      if (saved === undefined) delete process.env.PI_REPLMODE_MAX_CHANNELS;
      else process.env.PI_REPLMODE_MAX_CHANNELS = saved;
    }
  });
});

describe("an aborted call whose channel is still starting", () => {
  it("R4-06: gives the slot and the daemon back instead of holding them for the whole ready timeout", async () => {
    // R3-04's refusal tells the model to "wait for the call that is starting to finish", and says the
    // wedged creation cannot be freed. Half of that is true: `run` never looks at its AbortSignal until
    // after `getChannel` resolves, so pressing Esc on a call that is stuck starting changes nothing —
    // the creation keeps its slot (R2-03) and its half-spawned daemon for the entire ready timeout,
    // and every later call is refused because of a call the model already cancelled.
    const pidFile = join(ext.agentDir, "aborted-start.pid");
    const script = `import os, time
open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))
time.sleep(600)
`;
    const savedCap = process.env.PI_REPLMODE_MAX_CHANNELS;
    process.env.PI_REPLMODE_MAX_CHANNELS = "1";
    try {
      const controller = new AbortController();
      let wedged: Promise<any> | undefined;
      await withStub("aborted-start", script, { PI_REPLMODE_READY_TIMEOUT_MS: "7000" }, async () => {
        wedged = ext.callTool(
          "run",
          { code: "print('the call that was cancelled')", channel: "l-abortstart" },
          { signal: controller.signal },
        );
        await waitFor(() => existsSync(pidFile), 15_000, "the starting daemon to record its pid");
        controller.abort();
      });

      // The stub is out of the way again, so this call gets the real interpreter if there is room.
      const retry = await ext.callTool("run", { code: "print('room after an aborted start')", channel: "l-abortretry" });

      // Settle everything before asserting, so a red run cannot leave a wedged creation behind.
      const cancelled = await wedged!;
      const stubPid = Number(readFileSync(pidFile, "utf8"));
      await waitFor(() => !isPidAlive(stubPid), 20_000, "the aborted call's daemon to be taken down");

      expect(cancelled.isError, "the aborted call somehow succeeded").toBe(true);
      expect(text(retry), `a call aborted while starting held the only slot for its whole ready timeout: ${text(retry)}`).toContain(
        "room after an aborted start",
      );
    } finally {
      if (savedCap === undefined) delete process.env.PI_REPLMODE_MAX_CHANNELS;
      else process.env.PI_REPLMODE_MAX_CHANNELS = savedCap;
    }
  });

  it("R4-06: and does not send its cell to a channel that came up after the call was aborted", async () => {
    // The other half of the same missed abort: if the channel does come up (a slow environment build,
    // a cold import), the abandoned call walks straight into `runLocked`, sends its cell, and only then
    // notices the signal. The user pressed Esc, the tool result says it was aborted, and the cell ran
    // anyway — with whatever side effects a cell has by its first line.
    const framesFile = join(ext.agentDir, "aborted-frames.log");
    const script = `import json, os, sys, time
open(${JSON.stringify(framesFile)}, "w").write("")
time.sleep(2.0)
sys.stdout.write(${JSON.stringify(`${readyFrame("l-abortlate")}\n`)})
sys.stdout.flush()
while True:
    line = sys.stdin.readline()
    if not line:
        break
    with open(${JSON.stringify(framesFile)}, "a") as handle:
        handle.write(line)
`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 800);
    const result = await withStub("aborted-then-ready", script, { PI_REPLMODE_READY_TIMEOUT_MS: "30000" }, () =>
      ext.callTool(
        "run",
        { code: "open('/tmp/should-not-exist-r406','w').write('ran')", channel: "l-abortlate", timeout: 30 },
        { signal: controller.signal },
      ),
    );
    expect(result.isError, "a call aborted during startup was reported as a success").toBe(true);

    const frames = existsSync(framesFile) ? readFileSync(framesFile, "utf8") : "";
    expect(frames, `the aborted call sent its cell to a daemon that came up late: ${frames}`).not.toContain("execute");
  });

  it("R4-06: and the aborted call gets its answer at once, not when the ready timeout happens to fire", async () => {
    // The two probes above are about what an aborted start leaves behind. This one pins how the answer
    // arrives: the abort has to reach the start race itself. If it does not, the call sits until the
    // daemon's ready timeout — and pressing Esc is only honoured whenever that timeout is short, which
    // in a real session (two minutes) is indistinguishable from never.
    const pidFile = join(ext.agentDir, "aborted-promptly.pid");
    const script = `import os, time
open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))
time.sleep(600)
`;
    const controller = new AbortController();
    const started = Date.now();
    await withStub("aborted-promptly", script, { PI_REPLMODE_READY_TIMEOUT_MS: "30000" }, async () => {
      const wedged = ext.callTool(
        "run",
        { code: "print('cancelled while starting')", channel: "l-abortfast" },
        { signal: controller.signal },
      );
      await waitFor(() => existsSync(pidFile), 15_000, "the starting daemon to record its pid");
      controller.abort();

      const cancelled = await wedged;
      expect(cancelled.isError, "the aborted call somehow succeeded").toBe(true);
      expect(text(cancelled), `the aborted call did not say it was aborted: ${text(cancelled)}`).toContain("aborted");
      const stubPid = Number(readFileSync(pidFile, "utf8"));
      await waitFor(() => !isPidAlive(stubPid), 20_000, "the daemon of an aborted start to be stopped with it");
    });
    expect(Date.now() - started, "an aborted start waited for the ready timeout instead of for the abort").toBeLessThan(10_000);
  });
});

describe("a daemon that dies before its first output boundary", () => {
  it("does not lose the few bytes the interpreter had already written", async () => {
    // The startup complaint and the first cell's output share one stream, and the host only attaches
    // bytes captured before any block opened to the block that follows them. A daemon that dies between
    // receiving a cell and writing its opening marker has no block at all, and the exec it leaves behind
    // is the only place those bytes can go.
    const script = `import os, sys
sys.stderr.write("STARTUP-NOISE-BEFORE-ANY-CELL\\n")
sys.stderr.flush()
sys.stdout.write(${JSON.stringify(`${readyFrame("l-noboundary")}\n`)})
sys.stdout.flush()
sys.stdin.readline()
os._exit(6)
`;
    const result = await withStub("die-before-boundary", script, {}, () =>
      ext.callTool("run", { code: "print(1)", channel: "l-noboundary", timeout: 20 }),
    );
    expect(result.details.status).toBe("dead");
    const shown = text(result);
    expect(shown, `what the interpreter wrote before its first cell was dropped: ${shown}`).toContain("STARTUP-NOISE-BEFORE-ANY-CELL");
  });

  it("R3-10: and does not label those bytes as a cell's late output", async () => {
    // The bytes are parked in the last exec's log through `Exec.lateWrite`, which is the right call — it
    // survives a closed fd and caps the volume — but it narrates them as "output that arrived after this
    // cell ended … not from a cell". Here no cell ever ended: this is the interpreter's own startup
    // complaint, arriving before any cell ran. R2-07's rule for that header was that it must not claim
    // more than the host knows.
    const script = `import os, sys
sys.stderr.write("STARTUP-NOISE-BEFORE-ANY-CELL\\n")
sys.stderr.flush()
sys.stdout.write(${JSON.stringify(`${readyFrame("l-label")}\n`)})
sys.stdout.flush()
sys.stdin.readline()
os._exit(6)
`;
    const result = await withStub("label-the-startup", script, {}, () =>
      ext.callTool("run", { code: "print(1)", channel: "l-label", timeout: 20 }),
    );
    const shown = text(result);
    expect(shown, `the startup complaint is not in the answer at all: ${shown}`).toContain("STARTUP-NOISE-BEFORE-ANY-CELL");
    expect(shown, `the startup complaint is described as late output of a cell that never ran: ${shown}`).not.toMatch(
      /after this cell ended|after this cell/,
    );
  });

  it("R3-10: and once a block has opened, the startup header is never used again", async () => {
    // The claim behind R3-10's wording is that `loose` can only ever hold bytes from before the *first*
    // boundary of the channel: after any block closes, `lastClosed` routes capture to that exec's log
    // instead. Cell 2 here dies without ever opening a block, and the bytes between the cells belong to
    // cell 1 — under the header that says so. If this ever regressed, cell 2's log would carry a
    // "before any cell's output block opened" header for a channel that had already run a cell.
    const sentinels = `S = lambda i: "\\x00\\x1ePIRB\\x1e" + i + "\\n"`;
    const script = `import json, os, sys
${sentinels}
sys.stdout.write(${JSON.stringify(`${readyFrame("l-latecell")}\n`)})
sys.stdout.flush()
frame = json.loads(sys.stdin.readline())
sys.stderr.write(S(frame["id"]) + "cell one output\\n" + S(frame["id"]))
sys.stderr.flush()
sys.stdout.write(json.dumps({"t": "exec_end", "id": frame["id"], "ok": True, "status": "ok", "elapsed": 0.01}) + "\\n")
sys.stdout.flush()
sys.stdin.readline()
sys.stderr.write("NOISE-BETWEEN-CELLS\\n")
sys.stderr.flush()
os._exit(6)
`;

    let first: any;
    let second: any;
    await withStub("late-bytes-to-the-first-cell", script, {}, async () => {
      first = await ext.callTool("run", { code: "print('cell one')", channel: "l-latecell", timeout: 20 });
      second = await ext.callTool("run", { code: "print('cell two')", channel: "l-latecell", timeout: 20 });
    });

    expect(first.details.status, "the first cell was not reported as completed").toBe("completed");
    expect(second.details.status, "the second cell was not reported as dead").toBe("dead");
    expect(text(second)).toContain("exit code 6");

    const logFor = (result: any) => readFileSync(join(ext.agentDir, "replmode", "exec", `${result.details.id}.log`), "utf8");
    const firstLog = logFor(first);
    expect(firstLog, "the bytes between the cells were not attributed to the cell that ended last").toContain("NOISE-BETWEEN-CELLS");
    expect(firstLog, "the late bytes lost the header that says they came after that cell ended").toContain("after this cell ended");

    const secondLog = logFor(second);
    expect(secondLog, "the bytes between two cells were also written into the later cell's log").not.toContain("NOISE-BETWEEN-CELLS");
    expect(secondLog, "a channel that already ran a cell got the startup label for its bytes").not.toContain(
      "before any cell's output block opened",
    );
  });
});

describe("a daemon that closes its own protocol stream", () => {
  it("is treated as gone rather than left busy forever", async () => {
    // A cell that closes the daemon's private descriptors can leave a process that is alive, holds a
    // channel, and can never answer again. EOF on the protocol pipe is the only sign of it.
    const script = `import json, os, sys, time
sys.stdout.write(${JSON.stringify(`${readyFrame("l-eof")}\n`)})
sys.stdout.flush()
os.close(1)
time.sleep(300)
`;

    const started = Date.now();
    const result = await withStub("eof", script, {}, () => ext.callTool("run", { code: "print(1)", channel: "l-eof", timeout: 20 }));
    expect(Date.now() - started, "the host waited out the whole timeout").toBeLessThan(15_000);
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("dead");
    expect(text(result)).toContain("protocol stream");
  });

  it("R1-06: reports the real exit when a mute daemon gets up before the EOF grace runs out", async () => {
    // EOF on the frame stream counts as death, but the host waits 500 ms in case the exit event is on
    // its way with the actual reason. A daemon that dies inside that window must be reported with its
    // exit status, not with the vaguer "closed its protocol stream".
    const script = `import sys, time
sys.stdout.write(${JSON.stringify(`${readyFrame("l-eofexit")}\n`)})
sys.stdout.flush()
os = __import__("os")
os.close(1)
time.sleep(0.3)
os._exit(9)
`;
    const result = await withStub("eof-exit", script, {}, () =>
      ext.callTool("run", { code: "print(1)", channel: "l-eofexit", timeout: 20 }),
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("dead");
    const shown = text(result);
    expect(shown, `the real exit was overwritten by the grace timer: ${shown}`).toContain("exit code 9");
  });

  it("R1-06: reports the death of a daemon a cell killed by leaving SIGINT at its default action", async () => {
    // The disposition is only normalized at the *start* of a cell, so a cell that puts SIGINT back to
    // SIG_DFL and leaves one pending is delivered during the epilogue, and the default action ends the
    // process. `exec_end` may already be on the wire: the call still has to say the channel is gone.
    const warm = await ext.callTool("run", { code: "durable = 'kept'", channel: "l-dfl" });
    void warm;
    const result = await ext.callTool("run", {
      code: "import signal, os\nsignal.signal(signal.SIGINT, signal.SIG_DFL)\nsignal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})\nos.kill(os.getpid(), signal.SIGINT)\nprint('left a pending SIGINT')",
      channel: "l-dfl",
      timeout: 20,
    });
    expect(result.isError).toBe(true);
    expect(result.details.status, "a cell that killed its own daemon was reported as an ordinary call").toBe("dead");
    const shown = text(result);
    expect(shown).toMatch(/ended|gone/);
    expect(shown).toContain("variables are lost");

    const next = await ext.callTool("run", { code: "print(durable)", channel: "l-dfl" });
    expect(text(next)).toContain("[new channel");
    expect(next.isError).toBe(true);
  });
});

describe("an interrupt that takes the daemon with it", () => {
  it("R2-08: says an interrupt was in flight when the interrupt is what took the daemon down", async () => {
    // The status is `dead` — death outranks everything, and that is R1-06. What a model needs on top is
    // that the channel died *while being interrupted*: otherwise it reads a stopped task as a crashed
    // one and goes looking for a bug that is not there. Pass 1 set a status for this case that pass 2
    // found was unreachable, so the fact was silently gone (R2-08).
    const script = `import os, signal, sys, time
sys.stdout.write(${JSON.stringify(`${readyFrame("l-intdeath")}\n`)})
sys.stdout.flush()
signal.signal(signal.SIGINT, lambda *_a: os._exit(7))
sys.stdin.readline()
time.sleep(60)
`;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1200);
    const result = await withStub("interrupt-takes-the-daemon", script, {}, () =>
      ext.callTool(
        "run",
        { code: "import time\nwhile True:\n    time.sleep(0.1)", channel: "l-intdeath", timeout: 30 },
        { signal: controller.signal },
      ),
    );

    expect(result.details.status, "an interrupt is not a licence to report the call as interrupted").toBe("dead");
    const shown = text(result);
    expect(shown).toContain("exit code 7");
    expect(shown, `the result hides that the cell was being interrupted: ${shown.slice(0, 400)}`).toMatch(/interrupt/);

    const after = await ext.callTool("run", { code: "print('fresh channel after the interrupt')", channel: "l-intdeath" });
    expect(text(after)).toContain("fresh channel after the interrupt");
  });
});

describe("a session that ends while a channel is still starting", () => {
  // A quit in the middle of a file closes every channel that file has open. That is fine here (each test
  // names its own channel and starts it again), and it is why these two come last: nothing after them
  // can assume a channel from before them is still alive.
  it("F4-01: takes the half-started daemon down with it instead of leaving it running", async () => {
    // `bg_stop` has no task id for a channel that is still starting, and pass 3 accepted that. The host
    // does hold the creation, though, and `quit()` read only the map of *live* channels: a session
    // interrupted while a channel was coming up left a `python -m replmode` running with nobody left to
    // talk to it. Found with the real-pi smoke, not by any test.
    const pidFile = join(ext.agentDir, "quit-mid-start.pid");
    const script = `import os, time
open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))
time.sleep(600)
`;
    let call: Promise<any> | undefined;
    await withStub("quit-mid-start", script, { PI_REPLMODE_READY_TIMEOUT_MS: "30000" }, async () => {
      call = ext.callTool("run", { code: "print(1)", channel: "l-quitstart" }, { signal: new AbortController().signal });
      await waitFor(() => existsSync(pidFile), 15_000, "the starting daemon to record its pid");
      const shutting = Date.now();
      await ext.emit({ type: "session_shutdown", reason: "quit" });
      expect(Date.now() - shutting, "the quit waited for the ready timeout instead of closing the daemon").toBeLessThan(5_000);
    });

    const result = await call!;
    const stubPid = Number(readFileSync(pidFile, "utf8"));
    expect(stubPid, "the stub daemon never wrote its pid").toBeGreaterThan(0);
    await waitFor(() => !isPidAlive(stubPid), 20_000, "a quit to stop the daemon that was still starting");
    expect(result.isError, "the call the quit interrupted answered as if it had run").toBe(true);
    expect(text(result), `the answer blames something other than the ending session: ${text(result)}`).toMatch(/session ended/);
  });

  it("F4-01: and a daemon that becomes ready during the quit is not handed to the next session", async () => {
    // The quit walks the daemons it knows about, and a start already in flight can still finish inside
    // that window. Without the epoch check that daemon is adopted into a map the quit has already
    // cleared — nothing will ever close it — and its cell goes on the wire to a session that has ended.
    // The margins here are wide on purpose: the late daemon answers ready 1.2s in, while the quit is
    // still inside the 3s grace it gives a daemon that will not take SIGTERM.
    const pidDir = join(ext.agentDir, "f401-late");
    mkdirSync(pidDir, { recursive: true });
    const script = `import os, signal, sys, time
channel = [a for a in sys.argv if a.startswith("--channel=")][0].split("=", 1)[1]
open(${JSON.stringify(`${pidDir}/`)} + channel + ".pid", "w").write(str(os.getpid()))
signal.signal(signal.SIGTERM, lambda *a: None)
if channel == "l-quitlate":
    time.sleep(1.2)
    print(${JSON.stringify(readyFrame("l-quitlate"))}, flush=True)
time.sleep(600)
`;
    let late: Promise<any> | undefined;
    let stubborn: Promise<any> | undefined;
    await withStub("quit-late-ready", script, { PI_REPLMODE_READY_TIMEOUT_MS: "30000" }, async () => {
      // One daemon that will not die, so the quit is still walking when the other one answers.
      stubborn = ext.callTool("run", { code: "print(1)", channel: "l-quitstubborn" }, { signal: new AbortController().signal });
      late = ext.callTool("run", { code: "print(1)", channel: "l-quitlate" }, { signal: new AbortController().signal });
      await waitFor(() => existsSync(join(pidDir, "l-quitlate.pid")), 15_000, "both stub daemons to exist");
      await ext.emit({ type: "session_shutdown", reason: "quit" });
    });

    const results = await Promise.all([late!, stubborn!]);
    for (const name of ["l-quitlate", "l-quitstubborn"]) {
      const pid = Number(readFileSync(join(pidDir, `${name}.pid`), "utf8"));
      await waitFor(() => !isPidAlive(pid), 20_000, `${name} to be stopped by the quit`);
    }
    for (const result of results) {
      expect(result.isError, "a call whose session ended answered as if it had run").toBe(true);
      expect(text(result), `the answer does not say the session ended: ${text(result)}`).toMatch(/session ended/);
    }
  });
});
