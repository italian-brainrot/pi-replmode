/**
 * Channels that misbehave at the edges of their life: a daemon that never becomes ready, one that
 * answers a cell and then dies on the way out, one that closes its own protocol stream.
 *
 * These need a daemon that does something the real one never does, so they spawn a stub interpreter:
 * a real process on the real pipes speaking part of the real protocol, chosen by pointing
 * `PI_REPLMODE_ENV_DIR` at a directory whose `bin/python` is a script. The host side is unchanged —
 * it is still `src/` talking over pipes — only the thing on the other end is simpler and untrustworthy.
 *
 * Tests whose comment names an issue id (R1-nn) document a defect from the audit of that pass.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
