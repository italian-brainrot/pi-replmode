# Audit log

Each pass appends a section. Ids are `R<pass>-<n>` and are referenced from the tests that
demonstrate them, so a test comment naming `R1-03` belongs to the entry below with that id.

Severity: **BLOCKER** (breaks the tool for normal use) · **BUG** (wrong behaviour, reachable) ·
**PAPERCUT** (wrong in a way the model can work around) · **MISSING-COVERAGE** (untested, risk unknown).

---

## Pass 1 — 2026-10-31

Gate at the start of the pass: green (`tsc`, `biome`, 71 vitest, 26 pytest).
Gate at the end: `tsc`/`biome` green; **87 vitest (81 pass, 6 fail)** and **35 pytest (30 pass, 5
fail)** — every failure is a test written by this pass to demonstrate an issue below. New files:
`test/capture.test.ts`, `test/resilience.test.ts`, `test/cap.test.ts`, `python/tests/test_hardening.py`,
plus one test added to `test/env.test.ts`.

### R1-01 — BUG — an interrupt does not reach a cell that is waiting, only one that is spinning

`await` is a first-class feature of this REPL (it is in the tool description, the prompt section, and
both suites), but the daemon owns the event loop the cell awaits on. A SIGINT that lands while the
cell is suspended is raised by CPython in the thread *driving* the loop, so it escapes
`run_cell_async` entirely: the daemon logs `KeyboardInterrupt outside a cell; continuing`, re-enters
the loop, and the cell resumes its sleep and runs to completion. `interrupt()` therefore only works
while the cell is executing bytecode.

Consequences the model sees: an aborted foreground call returns `did not stop after an interrupt and
is still running` and backgrounds a cell that was never stopped; `bg_stop` reports the task as
unresponsive ("it did not stop on SIGINT within 5s … bg_stop with kill: true"), pushing the model
toward losing the channel's state; the channel stays busy for the whole remaining await. With
`bg_stop` this is a repeatable dead end: the task never stops on its own if the await is a loop.

Repro: `python/tests/test_hardening.py::test_interrupt_reaches_a_cell_that_is_waiting_at_top_level_await`
(cell `await asyncio.sleep(20)`, one SIGINT → `exec_end` arrives after 20 s with `status: "ok"`), and
`test/resilience.test.ts::R1-01` (abort during an await → `status: "running"`, channel still busy).
By hand: `await asyncio.sleep(8)` + SIGINT at 1 s → `exec_end` at 8.0 s, `status=ok`, capture holds
`after-await`.

Suggested fix: keep the raw loop and the default CPython handler (synchronous cells must keep
working — the existing interrupt tests pin that), but do not discard the KeyboardInterrupt the loop
catches. Run each cell as a task the `Runner` holds a handle to, and in that `except KeyboardInterrupt`
branch throw the interrupt into the in-flight task (`task.throw(KeyboardInterrupt())`) instead of only
logging. One SIGINT should stop the cell; extra ones must stay harmless.

### R1-02 — BUG — one cell can take interruptibility away from the whole channel, permanently

`deferred_interrupt` normalizes the SIGINT *mask* at each exec boundary, but nothing restores the
SIGINT *disposition*. A cell that runs `signal.signal(SIGINT, SIG_IGN)` (a plausible thing to write
around subprocess work) or installs a handler that returns leaves every **later** cell in that channel
unable to be interrupted — `bg_stop`, an aborted call and the escape key all stop working, and the
only way out is `bg_stop {kill: true}`, which loses the channel's variables.

Repro: `python/tests/test_hardening.py::test_a_cell_that_replaces_the_sigint_handler_does_not_disable_interrupts_for_the_channel`
(cell 1 sets `SIG_IGN`; cell 2's busy loop ignores three SIGINTs; the daemon stays alive). Verified by
hand: the disposition in a fresh daemon is `default_int_handler`; after such a cell it stays changed.

Suggested fix: at `_begin`, if `signal.getsignal(SIGINT)` is not `signal.default_int_handler`, restore
it and note the change in the daemon log. Same spirit as the existing mask rule, and it does not make
the *same* cell interruptible (which is out of scope and already documented).

### R1-03 — BUG — an exception that escapes `serve()` leaves the daemon alive but permanently deaf

`serve()` dispatches frames with no guard. Any exception that is not caught inside a frame handler
kills the `serve` task, and the daemon's `while True: run_until_complete(task)` loop then waits on a
task that can never make progress: the process stays alive, holds the channel, reads no further
frames, and never sends `fatal` or exits. From the host this is indistinguishable from a slow cell:
every later `run` hits its timeout and backgrounds, the channel is `busy` forever, `bg_wait` waits in
vain, and only `kill: true` frees it. The daemon log gets one unhelpful line.

Trigger (deterministic): `setvar` whose `path` blocks — a FIFO nobody opens — followed by one SIGINT.
The `KeyboardInterrupt` propagates out of `Runner.setvar` → `serve` → task dead.
Repro: `python/tests/test_hardening.py::test_a_frame_handler_that_raises_does_not_leave_the_daemon_alive_but_deaf`.
A realistic (racy, ~50% per attempt) version of the same defect: a cell that leaves SIGINT pending
across the exec boundary — `signal.pthread_sigmask(SIG_BLOCK, {SIGINT}); os.kill(os.getpid(), SIGINT)`
— gets the KeyboardInterrupt raised inside the task during `Runner._end`, and the channel goes deaf the
same way.

Suggested fix: make one frame incapable of killing the loop — wrap the dispatch in `try/except
BaseException` (log + `log` frame + continue), and treat a *cell* KeyboardInterrupt that escapes as an
interrupted cell rather than a task failure. Belt and braces: if the `serve` task does die, send
`fatal` and exit non-zero, so the host's existing death path reports the truth instead of hanging.

### R1-04 — BUG — the daemon's own traceback can be written into the capture stream

`Inbox._read` catches only `ValueError` from `decode_frame`. A frame that raises something else — a
deeply nested JSON document raises `RecursionError` — escapes an asyncio reader callback, and
asyncio's default exception handler logs the traceback **to stderr, which is the capture stream**. The
model then sees asyncio internals inside a cell's output (attributed to whichever cell runs next, via
the loose-bytes rule) and nothing at all reaches the daemon's log file. This directly contradicts
"the daemon's diagnostics go to a log file, never to its stdout … or stderr".

Repro: `python/tests/test_hardening.py::test_a_hostile_frame_keeps_the_daemons_own_traceback_out_of_the_capture`
(200 000 nested `[` on stdin; `Exception in callback Inbox._read()` then appears in the capture of the
following exec; the daemon log is empty).

Suggested fix: catch `BaseException` around the decode (a malformed frame is a `log` frame, not a
crash), and set `loop.set_exception_handler(...)` so anything asyncio reports goes to `Log` instead of
the capture pipe.

### R1-05 — PAPERCUT — a cell that closes fd 2 takes the channel down

`Runner._end` writes the closing sentinel to fd 2 in a `finally`. `os.close(2)` (or
`sys.stderr.close()`) in the cell makes that write raise `OSError` after `exec_end` has already been
sent, which escapes `Runner.run`, kills the task, and the daemon exits 1 with a `fatal` frame. Losing
a channel to a cell that mangled its own descriptors is survivable, but it should not be the daemon's
reaction: the capture stream belongs to the user's code and may be destroyed by it.

Repro: `python/tests/test_hardening.py::test_a_cell_that_closes_the_capture_stream_does_not_kill_the_channel`
(daemon exits with code 1 instead of answering the next frame).

Suggested fix: make `_capture`/`flush_streams` failure non-fatal (log a warning once per exec, note in
`exec_end` that the capture stream broke, and let the host's sentinel grace window do its job). Fixing
R1-03's dispatch guard alone would also downgrade this to "channel survives, output incomplete", which
is what the test accepts. Note that a *redirect* of fd 2 (as opposed to a close) is already handled
well — see "probed and solid" below.

### R1-06 — BUG — a call whose channel died is reported as `completed`

The two streams have no ordering, and `Exec.finalize` prefers the `exec_end` frame over the death:
`Channel.onExit` sets `deathNote`, then `finalize()` sets `status = frame.status`; `Channel.wait`
then returns `"finished"` because `exec.frame` exists. So a cell that kills the daemon after writing
`exec_end` (R1-05 is one way; a segfault or `os._exit` in the epilogue is another) comes back as an
ordinary successful result — no death note, no `[the channel is gone…]` line — and the *next* `run`
quietly starts a fresh daemon. The model is told the cell completed, keeps referring to variables that
are gone, and gets a `NameError` it cannot explain.

Repro: `test/capture.test.ts::R1-06` — result is `status: "completed"`, output
`printed before closing fd 2 / and after`, and the next call on the channel cannot see `durable`.
(`os._exit` in the *body* is already handled correctly by the existing `t-dying` test, because there
the frame never arrives.) The test accepts either shape of fix: the channel genuinely keeping its
state, or a result that says the channel ended. What it must not do is claim an ordinary success and
lose the state.

Suggested fix: a settled exec whose channel closed (`exec.deathNote` set / `channel.closed`) is
`"dead"` regardless of the frame — or at minimum keep `completed` but append the death note and the
"variables are lost" line. `statusOf` should not report `completed` for a channel that no longer exists.

### R1-07 — BUG — a boundary marker in the output drops the rest of the cell and leaks it into the next one

DESIGN.md says a false-positive sentinel costs "a cosmetic block split". The implementation does more:
`Channel.onBoundary` sends an unknown id to `this.sink = null`, so everything the cell prints after
the false marker goes into `loose`, is excluded from that exec's log (the cell's own result is
silently truncated), and is then prepended to the *next* exec's block. A cell that writes the bytes
`\x00\x1ePIRB\x1e` plus something matching `[a-z0-9-]{1,64}` followed by a newline loses output and
contaminates a later call. Trigger is exotic but the failure is silent, and a program that dumps
binary or captured data can produce it.

Repro: `test/capture.test.ts::R1-07` — `AFTER-MARKER` is missing from its own cell's result and
appears at the start of the next cell's output.

Suggested fix: a marker for an unknown exec is *data*: either ignore the boundary and keep the current
sink, or re-emit the marker bytes through `onBytes`. Update the DESIGN.md sentence to match whatever
is chosen.

### R1-08 — BUG — a process that outlives its cell has its output presented as the next cell's

Bytes that arrive while no block is open are buffered in `loose` and written to whichever exec opens a
block next. For a thread finishing a line or two that is the right call (the comment says so), but a
`subprocess.Popen` the cell never waited for — a server, a build, a watcher — streams into the host
indefinitely and then appears, unannotated, at the top of an unrelated cell's output. Two problems:
the model is shown output it did not produce and cannot attribute, and `loose` has no cap, so a
chatty orphan grows host memory for the life of the session.

Repro: `test/capture.test.ts::R1-08` — 25 `ORPHAN-n` lines from cell one's child precede
`CELL-TWO-OUTPUT` in cell two's result; the third cell is clean.

Suggested fix: cap the loose buffer (a bounded number of KB, with a `[… earlier output dropped …]`
note), and either attach it with an explicit note ("output that arrived after `repl-…` ended") or drop
it once the producing exec has settled. Whichever is chosen, the model must be able to tell whose
bytes they are.

### R1-09 — PAPERCUT — the truncation note reports the window, not the log

For a log larger than `MAX_READ_BYTES` (8 MB), `readLog` returns a tail window and
`finishedResult` feeds that window to `truncateMiddle`, so the note says
`output truncated: showing 29900 of 8388588 characters … (958 of 161319 lines)` for a 15.5 MB, 300 000-
line log, and the in-text `[... N characters and M lines not shown ...]` marker is wrong in the same
way. The bound global really holds 15.5 M characters, so the numbers the model is given do not match
the thing it is being told to slice.

Repro: `test/capture.test.ts::R1-09`.

Suggested fix: report true totals — `countOutput(logPath)` already counts bytes, lines and characters
in bounded chunks; use its numbers for the note (or state plainly that the shown totals are "of the
last 8 MB").

### R1-10 — BUG — killing a channel does not kill what its cells started

`Channel.close()` escalates to a group kill only if the daemon ignores the `shutdown` frame. The daemon
*does* answer `shutdown` (cleanly, quickly), so `killGroup` never runs and every process the cell
spawned survives in the now-orphaned process group. `bg_stop {kill: true}` — the escalation offered for
a runaway task — therefore stops nothing that is actually running: the model is told "the cell was
stopped by taking the whole channel down" while its `sleep 60`, dev server, or training loop keeps
burning CPU and holding the port. `session_shutdown reason: "quit"` (`PI_REPLMODE_KEEP_RUNNING=0`)
leaves the same children behind. `channel.ts`'s own header ("a group kill, so anything the cell started
dies with it") and the `bg_stop` description both promise otherwise.

Repro: `test/resilience.test.ts::R1-10` — after `bg_stop {kill: true}` the daemon is gone and
`bash -c sleep 60` is still alive; confirmed by hand for the `quit` path too.

Suggested fix: always take the process group down when a channel closes — SIGTERM then SIGKILL to
`-pid` after the daemon exits (the group survives as long as any member does), and do it in `quit()`
as well. Update the tool description if a narrower promise is intended.

### R1-11 — MISSING-COVERAGE — a daemon that never becomes ready

`READY_TIMEOUT_MS` is 120 s and unconfigured, so nothing can test the "daemon started but never sent
`ready`" path (an interpreter that hangs, a plugin that blocks import, a wedged `uv`). The failure
message and the `void channel.close(500)` cleanup are unexercised.

Suggested fix: read the timeout from the environment (`PI_REPLMODE_READY_TIMEOUT_MS`, capped) so the
path can be covered with a stub interpreter, then add that test.

### R1-12 — MISSING-COVERAGE — "changed pins mean a fresh env" is untestable

The env directory is named after a hash of `requirements.txt`, which is a compile-time constant
(`REQUIREMENTS_FILE` in `paths.ts`), so the property the design leans on — a changed pin gets a new
directory rather than a half-upgraded one — cannot be tested without editing the repo's pin file.

Suggested fix: let `PI_REPLMODE_REQUIREMENTS` point at a different requirements file (it is also useful
to users), then assert that two different files produce two directories.

### R1-13 — MISSING-COVERAGE — history rotation and damaged history

`recordHistory` rotates at 256 KB / 300 lines and `lastHistoryByChannel` silently skips a file whose
last line is not JSON (a torn append after a crash leaves exactly that). Neither path is covered, and
the rotation is the only code in the manager that rewrites a user-visible file.

Suggested fix: a test that seeds a history file past the rotation size, runs one cell, and checks the
file is still valid JSONL and ends with the new record; plus one that puts a truncated last line in a
history file and asserts the lost-channel note still says something useful.

### Probed and found solid (no issues)

- **Sentinel framing under chunking**: `CaptureSplitter` reassembles markers split at any chunk
  boundary (existing wire tests), and ordinary output is not delayed by held-back bytes.
- **The 750 ms sentinel grace window**: a cell that redirects fd 2 to `/dev/null` (so the closing
  sentinel never arrives) returns in ~780 ms, keeps the traceback via `exec_end`, and the channel is
  fine afterwards. Newly covered by `test/capture.test.ts`.
- **Stacked interrupts**: three SIGINTs into a busy cell → one `interrupted` exec, channel usable, no
  busy-spin. Covered by `test_stacked_interrupts_leave_the_channel_usable` and
  `test/resilience.test.ts`.
- **Interrupt during `subprocess.run`** works (the cell dies, the channel keeps its state); the
  `os.system`/`!cmd` variant is genuinely uninterruptible (CPython ignores SIGINT while it waits for
  the child), and the host's "it did not stop on SIGINT" wording is honest for it. The daemon
  recovers its own handler afterwards — now covered by
  `test_interrupt_is_still_delivered_to_later_cells_after_a_cell_uses_os_system`.
- **Frame reader resilience**: blank lines, non-JSON, JSON scalars and unknown frame types arriving
  between real frames are reported and skipped, and ordering survives
  (`test_the_frame_reader_keeps_its_place_after_junk_between_frames`).
- **Binary in the capture**: the daemon is byte-exact (NULs, high bytes, a lone record separator are
  delivered unchanged); the host replaces invalid UTF-8 on read and the call completes.
- **`truncateMiddle` at the limit**: never returns more than the budget (checked at 49 999/50 000/
  50 001/119 999 chars, single-line and many-line inputs, CRLF and ANSI content).
- **Very large output end to end**: an 11–15 MB cell streams to the log without loss, the tail window
  is used, and the nonce global really holds the whole capture.
- **Channel cap**: with every channel busy the cap error names the cap, the env var, and `bg_stop`;
  an idle channel is reclaimed instead. Now covered by `test/cap.test.ts`.
- **Retention sweep at `session_start`**: old exec logs go, recent ones and foreign files stay.
- **`ensureEnv` single-flight** in one process: two concurrent requests build once
  (`test/env.test.ts`).
- **SIGKILL of a daemon mid-cell** (foreground and backgrounded): reported `dead`, task listed `dead`,
  next call recreates the channel. Now covered by `test/resilience.test.ts`.
- **Real `pi` smoke** (`/tmp/pi-smoke-agent`, `pi --no-builtin-tools -p …`): registration, the prompt
  section, two parallel `run` calls serialized on one channel, and cross-call state all work; the
  model reported 42.
