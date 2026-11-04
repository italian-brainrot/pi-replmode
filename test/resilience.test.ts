/**
 * Interrupt and lifecycle under real pressure.
 *
 * The design's two rules are that a timeout never kills a cell and that SIGINT is the way a cell
 * dies. These tests hold the host to the other half of that: an interrupt has to reach a cell that
 * is *waiting* rather than spinning, a killed channel has to stop what its cell started, and a
 * channel that dies underneath a call has to be reported as dead instead of quietly replaced.
 *
 * Tests whose comment names an issue id (R1-nn) document a defect from the pass-1 audit and are
 * expected to fail until it is fixed.
 */

import { existsSync, readFileSync, utimesSync } from "node:fs";
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

const run = (code: string, params: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
  ext.callTool("run", { code, ...params }, options);
const bgWait = (timeout?: number) => ext.callTool("bg_wait", timeout === undefined ? {} : { timeout });
const bgStop = (task_id: string, extra: Record<string, unknown> = {}) => ext.callTool("bg_stop", { task_id, ...extra });

describe("interrupting a cell that is waiting", () => {
  it("R1-01: an aborted call stops a cell that is sitting in a top-level await", async () => {
    // The daemon owns the event loop the cell awaits on. A SIGINT that lands while the cell is
    // suspended is caught by the daemon's loop and dropped: the cell keeps waiting, the channel
    // stays busy, and the tool says the cell "did not stop after an interrupt".
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1200);
    const result = await run(
      "kept = 'still here'\nimport asyncio\nawait asyncio.sleep(20)\nprint('finished the await')",
      { channel: "r-await", timeout: 40 },
      { signal: controller.signal },
    );

    expect(result.isError).toBe(true);
    expect(result.details.status, "the await ignored the interrupt").toBe("interrupted");
    expect(text(result)).toContain("interrupted");

    const after = await run("print(kept)", { channel: "r-await" });
    expect(text(after), "the channel is still busy with a cell that was never stopped").toContain("still here");
  });

  it("stops a cell that is waiting on a subprocess it started", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1200);
    const result = await run(
      "import subprocess\nsubprocess.run(['sleep', '20'])\nprint('done')",
      { channel: "r-sub", timeout: 40 },
      { signal: controller.signal },
    );
    expect(result.details.status).toBe("interrupted");
    const after = await run("print('channel free')", { channel: "r-sub" });
    expect(text(after)).toContain("channel free");
  });

  it("leaves the channel usable after a second interrupt arrives on top of the first", async () => {
    const background = await run("import time\nwhile True:\n    time.sleep(0.05)", { channel: "r-stack", timeout: 1 });
    await bgStop(background.details.id);
    await bgStop(background.details.id);
    const after = await run("print('interrupted once, usable still')", { channel: "r-stack" });
    expect(text(after)).toContain("usable still");
  });
});

describe("killing a channel", () => {
  it("R3-05: a stop that took the channel down with the cell says the channel went too", async () => {
    // `bg_stop`'s promise is that the cell dies and the channel and its variables survive. A cell can
    // arrange otherwise — a SIGINT handler that exits, a C library that dies on the signal — and then
    // the answer is just "stopped (dead)", with no hint that the channel went with it. The next call
    // starts a fresh one and the model loses variables it was told were kept. Pass 2 put this exact
    // fact into the death note of a *foreground* call (R2-08); the background stop path never reads it.
    const task = await run("import signal, os, time\nsignal.signal(signal.SIGINT, lambda *a: os._exit(7))\nkept = 'kept'\ntime.sleep(30)", {
      channel: "r-stopdead",
      timeout: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 700));

    const stopped = await bgStop(task.details.id);
    const shown = text(stopped);
    expect(stopped.details.status).toBe("dead");
    expect(shown, `the stop answer hides that the channel died: ${shown}`).toMatch(/channel[^\n]*(gone|ended|died|dead)/);
    expect(shown, `the stop answer does not mention the interrupt that did it: ${shown}`).toMatch(/interrupt|SIGINT/);
    // The promise `bg_stop` breaks here is about the variables, so the answer has to say that word.
    expect(shown, `the stop answer does not say the channel's variables went with it: ${shown}`).toMatch(/variables/);

    // The variables really are gone, which is the thing the model has to be told before it reaches for
    // them rather than after.
    const after = await run("print(kept)", { channel: "r-stopdead" });
    expect(text(after)).toContain("[new channel");
  });

  it("R4-04: a stop for a task whose channel died after it finished still says the channel went", async () => {
    // The branch R3-05 never looked at: `bgStop` returns early for a task that had already settled,
    // before `stoppedResult` and before anything reads a death note. A background cell that finished and
    // then took the channel down with it (a segfault in the epilogue, a daemon killed on the way out, a
    // cell that closed the descriptors the daemon needs) is reported as an ordinary finished task, and
    // the model — told nothing about the channel — reaches for variables that went with it. The status
    // here is right; only the sentence about the channel is missing.
    const task = await run("kept = 'kept'\nprint('done')", { channel: "r-stopgone", timeout: 0 });
    const finished = await bgWait(20);
    expect(text(finished), "the background cell never finished, so this test is not testing what it means to").toContain(task.details.id);

    process.kill(task.details.pid!, "SIGKILL");
    await waitFor(() => !isPidAlive(task.details.pid!), 10_000, "the channel to go away behind its finished task");

    const stopped = await bgStop(task.details.id);
    const shown = text(stopped);
    expect(stopped.details.status, "a task whose channel died is reported as a live one").not.toBe("running");
    expect(shown, `a stop for a task whose channel is gone says nothing about the channel: ${shown}`).toMatch(
      /channel[^\n]*(gone|ended|died|dead)/,
    );
    expect(shown, `the stop does not mention the variables that went with the channel: ${shown}`).toMatch(/variables/);

    const after = await run("print(kept)", { channel: "r-stopgone" });
    expect(text(after), "the variables the model was left believing in are still there, so the note is noise").toContain("[new channel");
  });

  it("R4-04: and a process that has stopped but is not reaped yet reads as gone", async () => {
    // The window `channelGoneNote`'s fallback exists for: node has not been told about a death yet, so
    // the host's own flags still say the channel is there, and an answer built in that window must not
    // imply its variables survived. A zombie is the state to get right — `kill(pid, 0)` succeeds on one
    // — and a cell makes one at will, because Python never reaps a child nobody waits for.
    //
    // Imported here rather than at the top of the file: a static import of `src/` evaluates `paths.ts`
    // before `loadExtension` has pointed `PI_CODING_AGENT_DIR` at a temp dir, and the extension would
    // then run this whole file against the real `~/.pi/agent/replmode/`.
    const { processGone } = await import("../src/manager.ts");
    const task = await run('import subprocess\nchild = subprocess.Popen(["/bin/true"])\nprint("child", child.pid)', {
      channel: "r-zombie",
      timeout: 20,
    });
    const childPid = Number(/child (\d+)/.exec(text(task))?.[1]);
    expect(childPid, `the cell did not report a child pid: ${text(task)}`).toBeGreaterThan(1);

    // The live channel's own daemon must not read as gone: a probe that says otherwise would report
    // every working channel as lost, which is the harm R2-04 was about.
    expect(processGone(task.details.pid!), "a live channel's daemon reads as gone").toBe(false);
    await waitFor(() => processGone(childPid), 10_000, "the child the cell never waited for to read as gone");
  });

  it("F4-02: a call that arrives in the moment after a daemon dies gets a fresh channel, not a dead answer", async () => {
    // A daemon killed and a call that follows it at once: node has not been told about the death, the map
    // still holds a channel whose `closed` is false, and the call is handed that channel — its cell goes
    // to a dead pipe and the answer blames a death the model can do nothing about. This is the window a
    // flake in the test above fell into. The busy-wait is the point of the test, not a delay: it keeps the
    // loop from delivering the exit event before the call looks at the map, so the window is occupied on
    // purpose instead of raced.
    const first = await run("print('first')", { channel: "r-deadwindow", timeout: 20 });
    expect(text(first)).toContain("first");
    process.kill(first.details.pid!, "SIGKILL");
    const until = Date.now() + 100;
    while (Date.now() < until) {
      // hold the event loop: the child-exit event must still be pending when `run` asks for its channel
    }

    const after = await run("print('second')", { channel: "r-deadwindow" });
    const shown = text(after);
    expect(shown, `a call in the window after a death was handed the dead channel: ${shown}`).toContain("[new channel");
    expect(shown, "the fresh channel did not run the cell").toContain("second");
    expect(after.details.status, "the fresh channel did not come up live").toBe("completed");
  });

  it("R3-05: and a kill for a task whose channel is already gone says so without contradicting itself", async () => {
    // The escalation branch, probed at the edge R3-05's fix sits next to: the channel died on its own
    // first, and the model asks for `kill: true` afterwards. The answer must not pretend it took
    // something down, and must not promise the variables survived.
    const task = await run("import time\nprint('about to die')\ntime.sleep(30)", { channel: "r-killgone", timeout: 0 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.kill(task.details.pid!, "SIGKILL");
    await waitFor(() => !isPidAlive(task.details.pid!), 10_000, "the channel to die on its own");

    const killed = await bgStop(task.details.id, { kill: true, reason: "the channel is already gone" });
    const shown = text(killed);
    expect(killed.details.status).toBe("dead");
    expect(shown, `a kill for a channel that was already gone pretends it killed something: ${shown}`).toMatch(/already gone/);
    expect(shown, `the kill answer promises variables that are gone: ${shown}`).toContain("variables are gone");
  });

  it("R4-09: a killed channel still leaves its cell findable, by id or by log", async () => {
    // Closing a channel drops its tasks from the session registry, and `bg_stop {kill: true}`'s own
    // answer is the only thing the model gets about what it just destroyed — which names no log path,
    // unlike the plain stop right below it. So the cell's output disappears from the tool surface at the
    // moment the model is most likely to want it: the kill it just asked for, of a cell that had been
    // running for minutes. Either the answer names the log, or the listing still carries the task.
    const task = await run("import time\nprint('something worth reading')\ntime.sleep(30)", { channel: "r-killtrace", timeout: 0 });
    await new Promise((resolve) => setTimeout(resolve, 800));

    const killed = await bgStop(task.details.id, { kill: true, reason: "test" });
    const shown = text(killed);
    const listed = text(await bgWait(5));
    const tasks = (await bgWait(5)).details?.tasks ?? [];

    const findable =
      shown.includes(task.details.logPath) ||
      listed.includes(task.details.id) ||
      tasks.some((entry: { id: string; logPath?: string }) => entry.id === task.details.id && entry.logPath);
    expect(findable, `after killing channel "r-killtrace" nothing in the tool surface still points at the cell it ran: ${shown}`).toBe(
      true,
    );
  });

  it("R4-09: and a stop for a task the kill removed does not blame the retention window", async () => {
    // The same deletion, from the other side: the task id the model is holding now resolves to nothing,
    // and the error it gets says tasks "are pruned after 3 days" — a reason that is not what happened.
    // The id was dropped minutes ago, by the kill the model itself asked for.
    const task = await run("import time\ntime.sleep(30)", { channel: "r-killunknown", timeout: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await bgStop(task.details.id, { kill: true });

    const again = await bgStop(task.details.id);
    const shown = text(again);
    expect(again.isError, `a stop for a task its channel's kill removed was not an error: ${shown}`).toBe(true);
    expect(shown, `the answer blames a deletion the kill just made on the 3-day retention window: ${shown}`).not.toMatch(/pruned after/);
    expect(shown, `the answer does not say what happened to the task: ${shown}`).toMatch(/channel|closed|kill|gone/);
  });

  it("R5-04: and the log that answer sends the model to is one the retention sweep has left alone", async () => {
    // Every other place in this code that names a log checks it first: the settled `bg_stop` branch only
    // prints "Log:" when `existsSync` says the file is there, and the task listing prints
    // "(no log: <path>)" rather than pretending. The R4-09 answer is the one that quotes a path and
    // asserts the output is in it, unconditionally. It does not have to be: `pruneRetention` runs at
    // every session boundary — including the `/new`, `/resume` and `/reload` of a process that has been
    // running long enough for `droppedTasks` to still hold the id, since the manager is a `globalThis`
    // singleton that survives exactly those boundaries — and it unlinks logs older than three days, or
    // anything past the newest 200. Age one log and cross a boundary, and the sentence is now a lie the
    // model pays for with a FileNotFoundError.
    const task = await run("import time\nprint('the output somebody will ask for')\ntime.sleep(30)", { channel: "r-dropline", timeout: 0 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await bgStop(task.details.id, { kill: true });
    const logPath = task.details.logPath!;
    expect(existsSync(logPath), "the killed task left no log behind: the case cannot be exercised here").toBe(true);

    // The sweep's own criterion, applied honestly rather than a mock of it.
    const old = new Date(Date.now() - 4 * 86_400_000);
    utimesSync(logPath, old, old);
    await ext.emit({ type: "session_start", reason: "new" }, { hasUI: true });
    expect(existsSync(logPath), "the retention sweep did not delete the aged log: the case is not being exercised").toBe(false);

    const shown = text(await bgStop(task.details.id));
    // Either the answer points at a file that is there, or it says the log is gone. Naming the path and
    // promising the output is in it is the one combination that must not appear.
    const pointsAtTheMissingFile = shown.includes(logPath) && !/no longer|pruned|deleted|missing|gone|was in/i.test(shown);
    expect(pointsAtTheMissingFile, `the answer sends the model to read ${logPath}, which the sweep deleted: ${shown}`).toBe(false);
  });

  it("R6-03: and the answer's channel field names the channel its own sentence names", async () => {
    // R5-04 made this answer check the log path it points at, and R4-09 made it name the channel whose
    // kill removed the task. The sentence is right; the other two views of the same result are not.
    // `bgStop` reports this case by throwing, and the tool wrapper builds the failure result with the
    // channel it has — for `bg_stop` that is a hardcoded `"main"`. Measured at HEAD, one result:
    //   text      … Its channel "j-drop" was killed with bg_stop {kill: true} …
    //   details   {"channel":"main","status":"dead"}
    //   structured {"channel":"main","status":"dead",…}
    // A model that reads `structuredContent.channel` is told a channel called "main" is dead, when the
    // answer is about a different channel entirely.
    const task = await run("import time\nprint('a cell worth finding')\ntime.sleep(30)", { channel: "r-dropfield", timeout: 0 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await bgStop(task.details.id, { kill: true });

    const again = await bgStop(task.details.id);
    const shown = text(again);
    expect(again.isError, `a stop for a task its channel's kill removed was not an error: ${shown}`).toBe(true);
    // The case is still the one R4-09 filed for: the sentence knows which channel it is about.
    expect(shown, `the dropped-task answer does not name the channel it is about: ${shown}`).toContain('"r-dropfield"');
    expect(
      again.details?.channel,
      `the answer is about channel "r-dropfield" but its details say ${JSON.stringify(again.details?.channel)}: ${shown}`,
    ).toBe("r-dropfield");
    expect(
      again.structuredContent?.channel,
      `the answer is about channel "r-dropfield" but its structuredContent says ${JSON.stringify(again.structuredContent?.channel)}: ${shown}`,
    ).toBe("r-dropfield");
  });

  it("R6-03: and an id this process has never heard of claims no channel at all", async () => {
    // The other branch of the same answer. There is no channel in "unknown task: repl-… tasks are tracked
    // per pi process and pruned after 3 days", and the tool wrapper still filled `channel` with `"main"`
    // in both structured views — so the result reported that a channel called "main" was dead, for a call
    // that never named one.
    const again = await bgStop("repl-nosuchid");
    const shown = text(again);
    expect(again.isError, `a stop for an id nothing ever backgrounded was not an error: ${shown}`).toBe(true);
    expect(shown, `the answer does not say it has never heard of that id: ${shown}`).toContain("unknown task");
    expect(
      again.details?.channel,
      `the answer is about no channel and details names one: ${JSON.stringify(again.details)} — ${shown}`,
    ).toBeUndefined();
    expect(again.structuredContent?.channel, `and so does structuredContent: ${JSON.stringify(again.structuredContent)}`).toBeUndefined();
  });

  it("R1-10: takes the processes that its cell started down with it", async () => {
    // The escalation the model is offered when a task will not stop: `kill: true` says it ends
    // every cell in the channel. The daemon exits on the shutdown frame, so the group-kill
    // escalation never runs and the cell's children keep running - burning CPU and holding ports
    // after the channel that made them is gone.
    const pidFile = `${ext.agentDir}/orphan-child.pid`;
    const cell = await run(
      `import subprocess\nchild = subprocess.Popen(['bash','-c','sleep 60'], stdin=subprocess.DEVNULL)\nopen(${JSON.stringify(pidFile)},'w').write(str(child.pid))\nprint('spawned')`,
      { channel: "r-killkids", timeout: 0 },
    );
    await waitFor(() => existsSync(pidFile), 15_000, "the cell to record its child's pid");
    const childPid = Number(readFileSync(pidFile, "utf8"));
    expect(isPidAlive(childPid)).toBe(true);

    const killed = await bgStop(cell.details.id, { kill: true, reason: "test" });
    expect(text(killed)).toContain("killed");
    await waitFor(() => !isPidAlive(cell.details.pid!), 10_000, "the channel daemon to go away");
    await waitFor(() => !isPidAlive(childPid), 5_000, "the cell's child to be taken down with the channel");
  });

  it("reports a daemon that is killed underneath a foreground cell", async () => {
    const warm = await run("import os", { channel: "r-sigkill" });
    const pid = warm.details.pid!;
    const inFlight = run("import time\nprint('halfway')\ntime.sleep(30)\nprint('never')", { channel: "r-sigkill", timeout: 25 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    process.kill(pid, "SIGKILL");

    const result = await inFlight;
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("dead");
    expect(text(result)).toMatch(/ended|dead/);

    const fresh = await run("print('rebuilt')", { channel: "r-sigkill" });
    expect(text(fresh)).toContain("[new channel");
    expect(text(fresh)).toContain("rebuilt");
  });

  it("marks a backgrounded task dead when its channel is killed", async () => {
    const cell = await run("import time\ntime.sleep(30)", { channel: "r-sigkill-bg", timeout: 0 });
    process.kill(cell.details.pid!, "SIGKILL");
    const waited = await bgWait(20);
    expect(text(waited)).toContain(cell.details.id);
    const tasks: { id: string; status: string }[] = waited.details.tasks ?? [];
    expect(tasks.find((task) => task.id === cell.details.id)?.status).toBe("dead");
  });

  it("R1-10: takes the same processes down at session shutdown, not only on an explicit kill", async () => {
    // `PI_REPLMODE_KEEP_RUNNING=0` and a quit are documented to leave nothing running behind.
    const pidFile = `${ext.agentDir}/quit-child.pid`;
    await run(
      `import subprocess\nchild = subprocess.Popen(['bash','-c','sleep 60'], stdin=subprocess.DEVNULL)\nopen(${JSON.stringify(pidFile)},'w').write(str(child.pid))\nprint('spawned for the quit path')`,
      { channel: "r-quitkids", timeout: 15 },
    );
    await waitFor(() => existsSync(pidFile), 15_000, "the cell to record its child's pid");
    const childPid = Number(readFileSync(pidFile, "utf8"));
    expect(isPidAlive(childPid)).toBe(true);

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    await waitFor(() => !isPidAlive(childPid), 10_000, "the cell's child to die with the session");
  });

  it("R2: a session replacement with PI_REPLMODE_KEEP_RUNNING=0 takes the group down too", async () => {
    // The same promise, reached by the other switch: keeping channels alive across `/new` is the
    // default, and turning it off has to be as thorough as a quit.
    const pidFile = `${ext.agentDir}/keepzero-child.pid`;
    const started = await run(
      `import subprocess\nchild = subprocess.Popen(['bash','-c','sleep 90'], stdin=subprocess.DEVNULL)\nopen(${JSON.stringify(pidFile)},'w').write(str(child.pid))\nprint('spawned for a replacement')`,
      { channel: "r-keepzero", timeout: 15 },
    );
    await waitFor(() => existsSync(pidFile), 15_000, "the cell to record its child's pid");
    const childPid = Number(readFileSync(pidFile, "utf8"));

    const saved = process.env.PI_REPLMODE_KEEP_RUNNING;
    process.env.PI_REPLMODE_KEEP_RUNNING = "0";
    try {
      await ext.emit({ type: "session_shutdown", reason: "new" });
    } finally {
      if (saved === undefined) delete process.env.PI_REPLMODE_KEEP_RUNNING;
      else process.env.PI_REPLMODE_KEEP_RUNNING = saved;
    }
    await waitFor(() => !isPidAlive(started.details.pid!), 15_000, "the daemon to go with the replacement");
    await waitFor(() => !isPidAlive(childPid), 10_000, "the cell's child to go with it");
  });

  it("reports a foreground call whose channel is shut down underneath it", async () => {
    // `session_shutdown` can land while a cell is running: the call has to come back with the truth
    // rather than hang, and nothing may keep running afterwards.
    const warm = await run("print('warm')", { channel: "r-quitrace" });
    const pid = warm.details.pid!;
    const inFlight = run("import time\nfor _ in range(20): time.sleep(0.5)", { channel: "r-quitrace", timeout: 12 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await ext.emit({ type: "session_shutdown", reason: "quit" });

    const result = await inFlight;
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("dead");
    await waitFor(() => !isPidAlive(pid), 15_000, "the daemon to go away");

    // A later call gets a fresh channel rather than a wedge.
    const after = await run("print('usable again')", { channel: "r-quitrace", timeout: 20 });
    expect(text(after)).toContain("usable again");
  });

  it("R2-09: a cell that leaves the process group is out of reach of the group kill", async () => {
    // Pinned as a limitation, not as desired behaviour: `start_new_session=True` (or a double fork)
    // moves a child into a group of its own, so closing a channel cannot reach it. The promise in
    // `channel.ts` and DESIGN.md is about what a *cell started*, so either the docs have to carry the
    // exception or the kill has to do more than signal a group. If the kill improves, update this test.
    const pidFile = `${ext.agentDir}/escaped-child.pid`;
    const started = await run(
      `import subprocess\nchild = subprocess.Popen(['bash','-c','sleep 120'], start_new_session=True, stdin=subprocess.DEVNULL)\nopen(${JSON.stringify(pidFile)},'w').write(str(child.pid))\nprint('left the group')`,
      { channel: "r-escape", timeout: 15 },
    );
    await waitFor(() => existsSync(pidFile), 15_000, "the cell to record its child's pid");
    const childPid = Number(readFileSync(pidFile, "utf8"));

    await ext.emit({ type: "session_shutdown", reason: "quit" });
    await waitFor(() => !isPidAlive(started.details.pid!), 15_000, "the channel daemon to go");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const escaped = isPidAlive(childPid);
    process.kill(childPid, "SIGKILL"); // do not leave it for the next test
    expect(escaped, "the group kill now reaches processes outside the channel's group: update the docs").toBe(true);
  });
});

describe("a channel whose process cannot take a signal", () => {
  it("R5-05: does not blame the cell for a process the process table says is stopped", async () => {
    // A cell can stop the very daemon running it — `os.kill(os.getpid(), signal.SIGSTOP)`, a `kill -STOP`
    // on its own process group from a `!` command, a job-control helper that pauses the world. The
    // channel then answers nothing again: the cell detaches at its timeout, the channel reports itself
    // busy, and `bg_stop`'s SIGINT sits queued forever. That answer explains itself with a fixed
    // sentence — "Code that blocks signals, or a C extension holding the GIL, can do that" — and neither
    // is what is happening: a stopped process has not blocked anything, it is not executing, and no
    // signal reaches it until somebody continues it. The host already knows: `processGone` reads
    // `/proc/<pid>/stat` for exactly this channel and throws the state away the moment it has it. What
    // is pinned is only that the explanation must not name a cause the process table contradicts.
    const stopped = await run("import os, signal\nos.kill(os.getpid(), signal.SIGSTOP)\nprint('never printed')", {
      channel: "r-stopped",
      timeout: 5,
    });
    expect(stopped.details.status, "the cell that stopped its own daemon was not detached").toBe("running");
    const pid = stopped.details.pid!;
    // Read the state the host reads, so the finding is about the diagnosis rather than about whether a
    // stopped process is a real thing: `T` in /proc means stopped, and that is what the tool cannot say.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    expect(state, "this cell did not leave its daemon in the stopped state: the case is not being exercised").toBe("T");

    const attempt = await bgStop(stopped.details.id);
    const shown = text(attempt);
    expect(attempt.isError, "a stop that reached nothing was reported as a success").toBe(true);
    expect(shown, "the stopped channel was not reported as still running").toContain("still running");
    expect(shown, `the answer names a cause the process table contradicts (the daemon's state is T): ${shown}`).toMatch(
      /SIGSTOP|stopped process|process is stopped|state T|cannot (?:be )?interrupted/i,
    );

    // The escalation has to still work, and nothing may outlive the test.
    const killed = await bgStop(stopped.details.id, { kill: true });
    expect(text(killed)).toContain("killed");
    await waitFor(() => !isPidAlive(pid), 15_000, "the stopped daemon to be taken down by the group kill");
  });
});
