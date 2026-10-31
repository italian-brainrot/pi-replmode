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

---

## Pass 1 fixes — 2026-10-31

The fixer's turn. R1-01 … R1-13 are all addressed; the tests that demonstrated them pass **unchanged**
— none was weakened, skipped, or deleted, and none of the pre-existing tests changed either.

Gate after the fixes: `tsc`, `biome`, **95 vitest**, **42 pytest**, green (was 87 / 35 with 11 of them
red). Three pytest runs and two vitest runs back to back were checked for flakiness.

What each fix is, in one line each, followed by what pass 2 should try to break:

| id | fix | where |
| --- | --- | --- |
| R1-01 | the cell runs as a task the `Runner` holds; the loop hands the SIGINT it caught to that task | `Runner.cell_task`, `Runner.interrupt_cell` |
| R1-02 | the SIGINT *disposition* is normalized at `_begin`, like the mask already was | `Runner._restore_interrupt_handler` |
| R1-03 | every frame is dispatched inside `try/except BaseException`; a dead `serve` task sends `fatal` and exits 1 | `serve`, `main` |
| R1-04 | `BaseException` around frame decoding, and `loop.set_exception_handler` → the daemon log | `Inbox._read`, `main` |
| R1-05 | the daemon writes sentinels to its **own** dup of the capture pipe and repairs fd 1/2 per exec | `Runner.capture_fd`, `_capture`, `_restore_capture` |
| R1-06 | a death outranks the frame: `finalize` and `Channel.wait` report `dead`, the result says so | `Exec.finalize`, `Channel.wait`, `finishedResult` |
| R1-07 | a marker for an unknown exec is put back into the byte stream instead of closing a block | `CaptureSplitter.onBoundary(id, marker)`, `Channel.onBoundary` |
| R1-08 | bytes that arrive after a block closed go to *that* exec's log, announced and capped (256 KB) | `Exec.lateWrite`, `Channel.writeToSink` |
| R1-09 | truncation notes quote the file's real totals, from `countOutput` | `truncateMiddle(..., totals)`, `finishedResult` |
| R1-10 | closing a channel always takes the process group down (SIGTERM, then SIGKILL) | `Channel.close`, `killGroup` |
| R1-11 | `PI_REPLMODE_READY_TIMEOUT_MS` (capped at 600 s) makes the path testable | `readyTimeout()` |
| R1-12 | `PI_REPLMODE_REQUIREMENTS` selects the pin file; `envDirFor` is exported | `requirementsFile()`, `envDirFor()` |
| R1-13 | the newest *parseable* history record is used, the file is sealed before appending, `rotateHistory` exported | `lastHistoryByChannel`, `sealHistoryTail`, `rotateHistory` |

Hardening the audit did not ask for, because the fixes exposed it:

- **A daemon that cannot talk exits.** `send_frame` turns a failed protocol write into `ProtocolGone`,
  which ends the process with a non-zero status. Before, a cell that closed the daemon's own
  descriptors (`os.close(3)` — the saved protocol fd — or `os.closerange(3, 4096)`) left a process that
  was alive, held the channel, and could never answer again: exactly the R1-03 shape, reached a
  different way. Pinned by `test_a_cell_that_closes_the_daemons_own_descriptors_ends_the_channel_cleanly`.
- **The host treats EOF on the protocol pipe as the channel being over** (`Channel.attach`), so even a
  daemon that stays alive but mute cannot leave a channel busy forever. Pinned in
  `test/lifecycle.test.ts` with a stub that closes its own stdout and sleeps.
- **Each cell starts with a working capture stream.** `_begin` puts fd 1 and fd 2 back on the capture
  pipe and rebuilds `sys.stdout`/`sys.stderr` if a cell closed the *objects* rather than the
  descriptors; `_end` flushes into wherever the cell pointed them, then repairs, then writes the
  closing marker so the block always closes. A redirect or a close is now contained to the cell that
  did it. Covered by the two new pytest cases in that area.
- **`Exec.deathNote` is set on every exec in a dead channel**, not only the in-flight one, so a result
  built after the death cannot read the frame alone and call it a success.

Deliberate choices pass 2 should know about, rather than rediscover:

- **`asyncio.Task.throw` does not exist.** The audit's suggested shape is not implementable; the
  interrupt is injected into the future the cell task is parked on (`_fut_waiter`, one private
  attribute, descended through while it is itself a Task). If that future will not take the exception,
  the *second* interrupt cancels the task, and the cell then legitimately sees `CancelledError`: the
  frame reports `status: "interrupted"` with the real `ename`, and the daemon log says it was delivered
  as a cancellation. Do not "fix" that into pretending it was a `KeyboardInterrupt`.
- **A cell that changes the SIGINT disposition is not interruptible in its own cell.** It asked for
  that. Only later cells are protected, which is what R1-02 asked for.
- **`statusOf` still reports a finished task's own status after its channel is closed later** (an LRU
  eviction should not rewrite history as `dead`). The disclosure for a death that happened *during* a
  call lives in the call result instead.
- **Late capture is attributed, not hidden**: it goes to the log of the exec that produced it, with a
  header line, capped at 256 KB per exec with a "dropped" note. Startup noise (before any block has
  ever opened) is still attached to the first block, capped at 64 KB.

New tests written to try to defeat the fixes, all passing:

- pytest: an interrupt the cell absorbs and goes back to sleep (escalation), an interrupt on
  `asyncio.to_thread`, a custom SIGINT handler (not only `SIG_IGN`), `sys.stdout.close()` instead of
  `os.close(2)`, a redirect that must not follow the next cell around, a SIGINT left pending across the
  exec boundary, a cell that closes the daemon's own descriptors.
- vitest `test/lifecycle.test.ts` (new file, stub interpreters on the real pipes): never-ready daemon
  (R1-11) including its child process, `exec_end` then death without a closing sentinel (R1-06),
  protocol-stream EOF.
- vitest: the quit path's group kill (R1-10), an orphaned flood attributed and capped (R1-08), two pin
  files → two environment directories (R1-12), a torn history record (R1-13).

Docs updated with what changed: the sentinel false-positive sentence and the group-kill promise in
`DESIGN.md`, the interrupt design and the new env vars, plus `DEV.md`'s layout and "things that bite".

**Real-`pi` smoke after the fixes** (throwaway agent dir, `pi --no-builtin-tools -p …`, thinking left on
for `qwen38-flash-next` per `AGENTS.md`): three calls, state across them, reported 42 — and after pi
exited, neither the channel daemon nor the `subprocess.Popen(['bash','-c','sleep 45'])` the model had
spawned was left running, which is the R1-10 promise end to end. Pass 2 should re-run it if it touches
the daemon's startup, the capture path, or teardown.

---

## Pass 2 — 2026-11-01

Gate at the start: green — `tsc`, `biome`, 95 vitest, 42 pytest.
Gate at the end: `tsc` and `biome` green, **114 vitest (104 pass, 10 fail)**, **47 pytest green**. Every
vitest failure is a test this pass wrote to hold a defect below; none is a weakened or flaky leftover.
Two full runs back to back produced the same 10 failures, and the whole pytest suite ran twice with no
flake. New files: `test/honesty.test.ts`, `test/names.test.ts`; new tests in `test/format.test.ts`,
`test/capture.test.ts`, `test/cap.test.ts`, `test/lifecycle.test.ts`, `test/resilience.test.ts`,
`test/reload.test.ts`, `python/tests/test_hardening.py`. Nothing was deleted or loosened: the only
removed lines in the diff are a docstring sentence and an import that got wider.

Ten findings: **four BUGs, five PAPERCUTs, one MISSING-COVERAGE.** No BLOCKER. Two of the four BUGs
(R2-01, and the reporting half of R2-04) came from the pass-1 fixes themselves.

### R2-01 — BUG — a log bigger than the read window loses its tail completely

`truncateMiddle(text, max, ratio, totals)` (the R1-09 fix) computes the cut position from `totals`,
which describe the **whole file**, and then slices `text`, which is the **8 MB tail window** `readLog`
handed it. `tailStart = totalChars - tailBudget` is therefore an offset past the end of the string being
cut: `text.slice(tailStart)` is empty. The result is a head of ~30 KB taken from the middle of the log,
nothing from the end, and a note that admits it:

```
[output truncated: showing 29928 of at least 16777216 characters at the start and 0 at the end
 (516 of at least 291179 lines)]
```

The prompt promises "head and tail kept", and for a long run the last lines are exactly the ones that
matter (the summary, the exception, the final progress line). The existing R1-09 test only checks the
totals, and the "keeps the tail" test only checks that the *file* is big, which is why this slipped
through.

Repro: `test/format.test.ts::R2-01` (a 54 KB window plus `totals` for a 7 MB file → `tailChars === 0`)
and `test/capture.test.ts::R2-01` (a real 200 000-line cell whose `print('THE VERY LAST LINE')` never
reaches the result).

Suggested fix: keep `totals` for **reporting** and compute the cut in the coordinates of the text in
hand — `cutAtLineEnd(text, text.length - tailBudget, text.length - floor(tailBudget * 0.4))`. Verified:
with that one-line change the new tests pass and every pre-existing `truncateMiddle` expectation
(head+tail, line boundaries, the single-oversized-line fallback, the totals themselves) still holds.
The "N characters not shown" arithmetic stays right either way, since it subtracts the shown pieces
from the file's totals.

### R2-02 — BUG — the traceback gets no share of the 50 000-character limit

The 50 000 budget is spent entirely on the capture, and the traceback is appended afterwards,
unbounded. A cell that raises with data in its message — the thing that failed to parse, a row, a diff,
which is exactly what a model writes when it is debugging — blows the limit wide open:

```python
raise ValueError('unparseable: ' + 'x' * 300000)   # → a 300 336-character tool result
```

`details.evalue` and `structuredContent.error.evalue` carry the same string again. Nothing downstream
catches it: pi does not cap a tool result (`pi-agent-core` has no such limit), so the whole thing lands
in the model's context. `AGENTS.md` states the limit as a property of the tool, not of one part of the
result. A 400-frame recursive traceback is fine (IPython collapses repeats), so the hole is specifically
the exception value and the `evalue` field.

Repro: `test/honesty.test.ts::R2-02`. The sibling test in the same describe (a deep recursion) passes,
which pins what is *not* the problem.

Suggested fix: give the traceback a share of the budget (a few KB, head+tail), and make the full text
reachable the same way the capture is — append it to the exec log before truncating it in the result,
and say so in the note. Cap `details.evalue` / `structuredContent.error.evalue` to one short line; the
traceback already contains it.

### R2-03 — BUG — the channel cap is not enforced when calls arrive together

`makeRoom()` counts `this.channels`, and `createChannel()` calls it *before* `ensureEnv()` and
`startChannel()` put anything in that map. A burst of concurrent `run` calls therefore measures the cap
five times against an empty set and then starts five daemons. With `PI_REPLMODE_MAX_CHANNELS=2` and five
parallel calls on five channel names, all five daemons are alive afterwards. The cap is the only thing
standing between a session and N × ~45 MB of idle IPython, `run` is registered
`executionMode: "parallel"`, and `promptGuidelines` says "use separate channels for independent
long-running work" — so the recommended pattern is the one that defeats it. On the first call of a
session the window is much wider still, because every call waits inside `ensureEnv` for the same venv
build.

Repro: `test/cap.test.ts::R2-03` — asserts at most `cap` live daemons after `Promise.all` of five calls;
gets five.

Suggested fix: count in-flight creations against the cap (`this.starting` already exists for the
same-name case) and decide the room one channel at a time — either a small mutex around
`makeRoom`+create, or have `makeRoom` treat `starting` as live. Either shape leaves the existing
"all N channels are busy" refusal as the outcome for the calls that do not fit, which is already
tested in this file.

### R2-04 — BUG — channel names that collide once sanitised, and a live channel reported as lost

A channel name is used as a map key and, after `safeChannelName`/`historyFileName` (two copies of the
same function: replace every non-alphanumeric with `_`, cut at 40), as three file names: the daemon log,
the history file and the IPython profile directory. Two consequences:

1. **A live channel is announced to the model as gone.** `lostChannelNotes()` keys its map by the
   history *file stem* and then asks `this.channels.get(<stem>)`. For any name that is not already a file
   name, the stem is not a key in the live map, so `run(channel: "notes/live")` is followed — at the next
   `session_start`, in the same process — by a prompt section saying
   `notes/live: last cell completed … — their variables were lost` and a matching `ui.notify`. The
   channel is running, its variables are bound, and the model is told the opposite and invited to
   "re-create what you need".
2. **Two channels share one history file.** `a/b` and `a_b` both append to `a_b.jsonl`, so only the
   newest of the two survives, and the note reports the *stem*, not a name the model ever used. They also
   share a daemon log (the two daemons' lines interleave — confirmed by hand) and an IPython profile
   (two `history.sqlite` writers in one directory).

Repro: `test/names.test.ts` — two tests, one per consequence.

Suggested fix: one shared encoder, collision-free (sanitise, then append a short hash of the real name
when the sanitised form is not unique — or always). Key the note by the record's own `channel` field,
which already holds the real name (`recordHistory` writes it; `lastHistoryByChannel` currently overwrites
it with the file stem), and check liveness against that. If instead a name is going to be constrained,
say so in the `channel` parameter description — right now it says nothing about what a name may contain.

### R2-05 — PAPERCUT — `run`'s structuredContent does not match the outputSchema `run` declares

Measured across eight paths:

| path | problem |
| --- | --- |
| background (`timeout: 0`) | no `output`, no `truncated` — both declared required |
| busy-channel refusal | no `output`, no `truncated`, no `elapsed_seconds`; `status: "error"` |
| empty code / invalid timeout | same, plus `status: "error"` |
| dead channel | no `truncated` |

`status: "error"` is not in the declared union (`completed|failed|interrupted|running|dead`) and is not a
`TaskStatus`; it comes from `failure()` in `index.ts`, which also puts `"dead"` in `details.status` for
the same result, so the two views disagree. DESIGN notes the schema is descriptive and not validated at
runtime, which is precisely why it matters: it is what a model reads when it wraps the tool, and what any
later validation would check.

Repro: `test/honesty.test.ts::R2-05` — one test, a message listing every path and every problem.

Suggested fix: decide one shape and make both ends agree — mark `output`/`truncated`/`elapsed_seconds`
optional (they genuinely do not exist for a call that never reached a daemon) or fill them with defaults,
and give `failure()` a status from the enum that matches `details.status`.

### R2-06 — PAPERCUT — a channel that cannot start says nothing about why

The daemon goes out of its way to explain a failed start, and the host throws the explanation away:

- a `fatal` frame ("IPython is not installed in this environment") lands in `channel.notes()`, which is
  only ever shown by `deadResult` — the "could not start" path never reads it;
- the interpreter's own traceback, which lands on the capture stream when the cached environment is
  broken, is dropped by construction: `onExit` calls `flushLoose()` (which empties `this.loose`) *before*
  `readyFail(... startupOutput() ...)`, so `startupOutput()` — whose docstring says a startup traceback is
  "the one thing worth reporting" — is always empty there;
- `flushLoose()` also writes with `Exec.write`, which no-ops once the exec's log fd is closed, so trailing
  capture for a settled exec is silently dropped rather than appended the way `lateWrite` does it.

The model gets `channel "x" could not start: the Python process behind channel "x" ended (exit code 1)`
and a daemon log that may not exist at all.

Repro: `test/lifecycle.test.ts` — two tests using stub interpreters (a `fatal` frame, and a bare
interpreter crash).

Suggested fix: build the start-failure message from `deathNote` + the `fatal` frame text +
`startupOutput()` (read before the buffer is emptied; `flushLoose` should append through the same path
`lateWrite` uses). `manager.run`'s `catch` around `getChannel` just forwards `error.message`, so the fix
belongs in `Channel.onExit`/`startChannel`.

### R2-07 — PAPERCUT — R1-08's fix is the easy half: an orphan's output still lands inside a later cell

The fix attributes bytes that arrive **while no block is open** to the exec that closed last. But an
orphan that keeps writing spends most of its time while *some later cell's block is open*, and those
bytes go into that cell's output stream, indistinguishable from its own prints: cell two, which sleeps
two seconds, comes back as

```
CELL two start
ORPHIN-7 … ORPHIN-40
CELL two end
```

with no marker and no note. The attribution point also walks forward: `lastClosed` is whichever exec
closed last, so a four-second orphan had LATE-1…10 in the producer's log, LATE-11…25 in the *next*
cell's log under a header claiming "output that arrived after this cell ended", and would have continued
into the third. That header is literally true and practically misleading.

Repro: `test/capture.test.ts::R2-07` (written the way R1-08 was: fail only if the output is contaminated
*and* undisclosed, so either fix shape passes).

Suggested fix, in order of honesty: (a) the real fix is one capture pipe per exec — `_begin` installs a
fresh pipe pair on fd 1/2, the host keeps draining the older execs' pipes into their own logs — which
makes attribution exact and is a DESIGN change to the "two pipes" model, so it needs deciding, not
sneaking; (b) the cheap fix is to say precisely what is guaranteed: rewrite the attribution paragraph in
DESIGN.md and the "things that bite" bullet in DEV.md to state that only bytes between blocks are
attributable, and word the header so it does not imply causation ("output that arrived during this block
from something other than this cell" is not knowable, so the honest version is "unattributable output").

### R2-08 — PAPERCUT — `Exec.killRequested` has no reader: pass 1's fix made a branch unreachable

`Channel.onExit` sets `exec.status = exec.killRequested ? "interrupted" : "dead"` for an unsettled exec,
and then `Exec.finalize` — which `onExit` calls two lines later, after having set `deathNote` — unconditionally
overwrites the status with `"dead"`. So the intent (a cell whose interrupt happened to take the daemon
with it is reported as interrupted) is silently gone, and the field is written in three places and read
in one that cannot matter. It is not wrong behaviour — R1-06 says death outranks everything — it is dead
code that reads like a guarantee.

No test (there is no observable behaviour to pin). Suggested fix: delete the ternary and the field, or
keep the field and use it in the *text* ("the interrupt took the daemon with it") which is the case a
model would otherwise misread.

### R2-09 — PAPERCUT — a cell that leaves the process group is out of the group kill's reach

`channel.ts`'s header and DESIGN both promise that closing a channel takes down "anything the cell
started". A child started with `start_new_session=True` (or a double fork — a normal way to launch a dev
server that should survive) moves into a group of its own, so `killGroup(-pid)` cannot see it: the daemon
goes, the server stays. This is not fixable by signalling harder without walking a process tree, which
would be worse.

Repro/pin: `test/resilience.test.ts::R2-09` — a **passing** test that asserts the escape and says out
loud that it should be updated if the kill ever gets smarter. Suggested fix: state the exception next to
the promise in `channel.ts`, DESIGN.md and (one clause) the `bg_stop` parameter description.

### R2-10 — MISSING-COVERAGE — the model-facing prompt has not caught up with what the tool does

The section and the guidelines are accurate as far as they go, and three things the model routinely needs
are missing: `bg_stop {kill: true}` is never mentioned outside the parameter description; nothing tells
the model that killing a channel also ends the servers, builds and training loops its cells started
(R2-09's exception doubly so); and the guidelines push "use separate channels" — the pattern R2-03 shows
is unbounded — without mentioning that the channel count is capped and the idlest channel is quietly
retired with its variables. One line each in `SECTION_LINES`, plus a `promptGuidelines` entry, and a
`test/prompt.test.ts` assertion per line.

Also unprobed and unpinned, deliberately left alone: a `code` string big enough to exceed the daemon's
`MAX_FRAME_BYTES` (64 MB) is dropped as `_overlong`, leaving an exec the host believes in — the channel
then looks busy forever until it is killed. Unreachable through the tool layer (a 64 MB tool-call
argument), and the honest fix is host-side: refuse an over-long cell before sending it.

### Re-checking pass 1's fixes

Each R1-nn was re-run (`npm run py:test -- -k <name>`, the vitest file named in the pass-1 table) and
attacked again at the fix rather than the symptom:

| id | what pass 2 tried against the fix | result |
| --- | --- | --- |
| R1-01 | eight `await` shapes — `TaskGroup`, `shield`, `gather(shield(…))`, an `Event` another task also waits on, `create_subprocess_exec().communicate()` (the transport's own exit waiters), `run_in_executor`, an `await` inside a `with open(...)` whose `finally` must run, and `asyncio.wait([...])`. New: `test_an_interrupt_reaches_a_cell_parked_on_any_shape_of_await` | held. Every shape stopped, `status: "interrupted"`, daemon alive, next cell answered. No descent hung the loop, corrupted a sibling task or left a cell half-dead. A `shield` leaves its inner task running — that is what `shield` means — and it surfaces as nothing |
| R1-02 | a cell that sets `SIG_DFL` *and* leaves a SIGINT pending (new host test in `test/lifecycle.test.ts`): the pending signal is delivered during the epilogue, the default action kills the daemon | held, honestly: the call comes back `dead` with the "variables are lost" note, the next call reports `[new channel]` |
| R1-03 | interrupts fired continuously across exec boundaries while cells start and finish; a `setvar` on a FIFO (unchanged) | held: 12/12 cells reported, daemon alive and answering |
| R1-04 | re-ran the hostile-frame test | held |
| R1-05 | a cell that puts a **pipe it made itself** on fd 1 and reads from it (new: `test_a_cell_that_moves_fd_1_onto_its_own_pipe_does_not_blind_the_channel`) — harder than `/dev/null` because there is a reader on the other end | held: nothing leaked into the protocol, no `_nonjson` frames, the daemon logged "restored fd 1", and the next cell's output arrived |
| R1-06 | death landing after `exec_end` two ways: the SIG_DFL case above, and a mute daemon that exits *before* the 500 ms EOF grace (new test asserts the real exit code survives the grace timer) | held; the guard `if (this.closed) return` in `onExit` keeps the reason from being overwritten |
| R1-07 | re-ran the forged-marker test; also forged a marker carrying a **real** exec id of the channel | held: the marker stays data. A forged marker with a genuine id closes that block early and the rest of the cell arrives as late output under the "after this cell ended" header — self-inflicted, and the header is not a lie |
| R1-08 | an orphan that outlives its cell by several seconds while two more cells run | **partly broken — R2-07.** Between-block bytes are attributed and capped exactly as promised; during-block bytes are not attributable at all |
| R1-09 | re-ran; added a log past `countOutput`'s 16 MB scan cap (new passing test asserts the "at least" wording) | the totals are honest; **the fix broke the tail — R2-01** |
| R1-10 | re-ran both kill tests; added the `PI_REPLMODE_KEEP_RUNNING=0` replacement path (new passing test) and `start_new_session=True` (R2-09) | held for everything in the group; a child that leaves the group is unreachable |
| R1-11 | re-ran; added `PI_REPLMODE_READY_TIMEOUT_MS=1` against a healthy environment (new passing test) | held: clean failure, daemon reaped, retry works |
| R1-12 | re-ran `test/env.test.ts` | held |
| R1-13 | re-ran the torn-record and rotation tests; then attacked *the file naming* rather than the parsing | parsing held; **the naming is R2-04** |

### Probed and found solid (no findings)

- **Reload and session replacement against everything new.** A cell backgrounded in one runtime is
  waited for and stopped from the next (`bg_wait`, `bg_stop` — new test in `test/reload.test.ts`);
  channels, their variables and their `pid`s survive; a quit after a reload still takes the group down.
  Late capture is still attributed to the right exec across a reload. `/new`, `/resume` and `/fork` keep
  daemons, `PI_REPLMODE_KEEP_RUNNING=0` shuts them down, and a `run` racing `session_shutdown quit` comes
  back `dead` with nothing left running afterwards (new test in `test/reload.test.ts` and one in
  `test/resilience.test.ts`).
- **Concurrency at the edges.** `bg_wait` racing `bg_stop {kill: true}` and a second plain `bg_stop` on
  the same task: one coherent story, no double-kill, no wedged registry. Two `run`s racing an LRU
  eviction: the evicted channel's state is gone and its next call says `[new channel]`. A `run` racing a
  channel kill gets a fresh channel and the `[new channel …]` banner, which is the truth. `makeRoom`
  never picks a channel with a cell in flight, and there is no window in which a channel with a call in
  flight looks idle (nothing between `begin()`, `send()` and `wait()` awaits).
- **The interrupt ladder's text.** `timeout: 0` → `bg_wait` → `bg_stop` → `bg_stop {kill: true}` in one
  channel: each answer says what it did and points at the log; a stopped-then-listed task reports
  `interrupted`, and after a kill the task leaves the registry (defensible — the listing is for things
  that can still be waited on — but the killed task's log path is then only in the earlier message).
- **Cells that reach for the wire.** `breakpoint()` and `%debug` fail with the patched `input()` error
  instead of reading frames (new pytest), and `sys.stdin.readline()` in a cell returns immediately
  because the daemon keeps fd 0 non-blocking — no hang, no stolen frame.
- **Interrupt storms across exec boundaries.** 12 cells with a SIGINT every ~20 ms: every exec is
  bracketed by exactly two whole markers (the prefix count and the completed-marker count agree), no
  half-written boundary, daemon alive, channel usable (new pytest test).
- **Hostile channel names as file names.** `../../escape` and `...` are sanitised; nothing escapes the
  history or daemon directories (the collision is R2-04, the traversal is not).
- **Daemon-log growth.** Every restore and normalisation emits one `log` frame per exec; the host's
  `daemonNotes` ring is capped at 40, `loose` at 64 KB, late capture at 256 KB per exec, exec records at
  100 per channel and the task registry at 200. A cell cannot make the daemon emit a frame per *byte*.
- **The EOF-vs-exit grace.** A daemon that closes its protocol stream and stays alive is declared gone
  in well under the timeout; one that exits at 300 ms keeps its exit code (new test).
- **`details.status` vs the text** in the paths that pass: interrupted calls say "the channel and its
  variables are intact" only when the channel is really alive; dead ones say both what finished and that
  the state is gone.

---

## Pass 2 fixes — 2026-11-01 (fixer)

Gate at the start: `tsc`/`biome` green, **114 vitest (104 pass, 10 fail)**, 47 pytest — the ten failures
are pass 2's holding tests. Gate at the end: **green — `tsc`, `biome`, 123 vitest, 47 pytest**, run twice
with identical results. All ten findings are fixed; every holding test went green untouched, with one
mechanical exception argued under "One test changed" below. Nine tests were *added* to pin the fixes
themselves: the traceback escape hatch and the shared budget (honesty ×2), the name encoder (names ×2),
the bounded start-failure report and the interrupt-in-flight note (lifecycle ×2), and the model-facing
promises about the cap, the guidelines and what a kill can reach (prompt ×3).

Real-`pi` smoke re-run afterwards (throwaway agent dir, thinking on for `qwen38-flash-next`): three
calls, state across them, a second channel that correctly could not see the first one's variable,
42 reported — and after pi exited neither daemon nor the `sleep 45` a cell had spawned was left running.
A second smoke run put a 300 000-character exception through the real tool layer: the answer came back
under the limit with the head and tail of the traceback, the whole text in the exec log and bound to
`_out_…`, and it is what found the note bug described under R2-02.

### R2-01 — cut where the text is, report where the file is

`truncateMiddle` now computes both cuts from `text.length`; `totals` is used only for the numbers quoted
back to the model. The single-oversized-line fallback moved to the same coordinates (it had the same
bug). The "N characters and M lines not shown" arithmetic is unchanged, since it subtracts the shown
pieces from the file's totals either way.

*Pass 3 should try:* a log whose last line is itself megabytes; a window whose first partial line was
already dropped by `readLog` (does the head cut land inside a mangled line?); a log just over
`MAX_READ_BYTES` where `windowed` is true but the totals nearly equal the window; `countOutput` past its
16 MB scan cap combined with a windowed read (two "at least" floors in one note).

### R2-02 — the traceback gets a share of the limit, and the whole thing stays on disk

`finishedResult` now gives the traceback whatever the capture did not need, with a floor of 25 % of
50 000 (`TRACEBACK_SHARE`) and a ceiling of the limit itself, and cuts the capture to what is left, so
the answer cannot exceed the limit no matter what the exception's message held — and a traceback that
fits comfortably is not cut just because room was reserved for output that never arrived. When the traceback itself is cut, the full text is appended to the exec log under
`[full traceback for this cell]` first, and the nonce global is bound even when the capture needed no
truncation — shortening is only honest if the whole thing is still reachable, which is the same deal the
capture has. `details.evalue` / `structuredContent.error.evalue` are clipped to one line of 500 characters
(`oneLine`), in the task listing too. `deadResult`'s capture read 1 MB and pasted it in; it is now cut to
60 % of the limit with a note pointing at the log.

Known asymmetry, deliberately left: `structuredContent.output` is the capture only, not the traceback —
the traceback is not output. A pass-3 pass may decide that is its own papercut.

The real-`pi` smoke found one reporting bug in this fix while it was still being written: the note said
"showing 12974 of 300252 characters" for a head-**and**-tail cut, i.e. the R2-01/R1-09 mistake (quote one
number, show two pieces) in a new place. The note now says "… at the start and N at the end" like the
output note does, and the test asserts the tail number is real.

*Pass 3 should try:* the recursion path (IPython collapses repeats — it was never the hole, and it is
pinned as passing); `sys.setrecursionlimit` + a traceback whose *middle* is the payload; a cell that
prints 8 MB *and* raises (both truncations live at once, `at least` wording); a traceback exactly at the
boundary of the shared budget; whether the appended traceback in the log confuses a later `readLog`/
`countOutput` of that same log; whether `truncated: true` for a traceback-only cut is what a consumer
expects.

### R2-03 — in-flight creations occupy a slot

`makeRoom` counts the union of live channels and names whose creation has not finished (a `Set`, so a
name in both maps counts once). The five-parallel-calls burst now gets two channels and three refusals.
Refusals went through `createChannel`, so they were dressed as `channel "x" could not start: …`; the cap
error is now a `ChannelCapacityError` and `run` returns it as a plain refusal with `status: "running"`
(other channels are running; nothing died), because "could not start" tells the model to go fix its
environment when the truth is "wait or free one".

*Pass 3 should try:* a burst where some creations *fail* (does the slot come back? `starting` is cleared
in a `finally`, and a killed-during-creation channel is closed so it drops out of `live`); a cap of 1;
the same name from five calls at once (single flight, one daemon); whether an eviction can now take a
channel that is mid-creation (it cannot — only `live` channels are candidates); a long `ensureEnv` build
holding a slot, which is intended but new: on the first call of a session the window pass 2 exploited is
closed, so the model gets refusals instead of N daemons.

### R2-04 — one encoder, and the note uses the real name

New `src/names.ts`: `channelFileStem` sanitises, and appends a 10-hex-character digest of the real name
*unless the name is already a usable file name*. `main`, `t-hist` and every other plain name keep their
obvious file names (and the tests and humans who read those files by eye are unaffected); `a/b` becomes
`a_b-28b6…`, so the daemon log, the history file and the IPython profile stop being shared. One function
serves all three — the duplication (`safeChannelName` in `channel.ts`, `historyFileName` in `manager.ts`)
was how they drifted. `lastHistoryByChannel` keys by the record's own `channel` field (which
`recordHistory` always wrote) and falls back to the file stem only for a record that has none, so a live
channel is never again announced as lost, and an *old* history file written under the old naming is still
read correctly because the record inside it carries the real name.

*Pass 3 should try:* names that differ only after the 40-character cut; names whose digest collides
(40 bits over a handful of human-chosen names — say so if you can build a collision in a session);
unicode and empty-ish names (`channelFileStem("")` → `channel-<digest>`); a channel renamed between two
pi processes; whether `IPYTHONDIR` changing shape strands anything that matters (it strands a
`history.sqlite`, which is disposable); traversal again — the encoder never emits `.` or `/`, but that is
worth re-proving against the *daemon's* own `--log` argument, not just the history dir.

### R2-05 — the schema describes the answers the tool gives

`output`, `truncated` and `elapsed_seconds` are optional in `RUN_OUTPUT`: a busy channel, an empty cell,
an invalid timeout and a backgrounded call genuinely have none. `failure()` no longer invents
`status: "error"` — it uses the declared enum and puts the same value in `details` and
`structuredContent`. No protocol change, so no compat row.

*Pass 3 should try:* any path where the two views disagree; `statusOf` for a finished task whose channel
dies later (deliberately still reports its own status); whether `task_id`/`killed`/`outcome` keys that
`bg_wait`/`bg_stop` emit should be declared too (`additionalProperties: true` makes them legal, not
documented).

### R2-06 — a channel that could not start says why, in the daemon's own words

Three separate breaks, all in `Channel`: the `fatal` frame text is now kept in its own field (the note
ring was never read by the start-failure path); `startupOutput()` is read *before* anything empties
`loose`, and `flushLoose()` appends through `Exec.lateWrite` instead of `Exec.write`, which no-oped once
the log descriptor was closed; and the report waits for the child's stdio to close (bounded by
`STDIO_DRAIN_MS`, because `exit` can beat the last of stderr) before deciding the process said nothing.
The composed message is head-and-tail cut at 3000 characters with a pointer to the daemon's log file, so
a 60 KB startup traceback on the capture stream cannot blow the answer limit either — that was a hole
adjacent to R2-02 and is now pinned by its own test.

*Pass 3 should try:* a daemon that writes its complaint *slowly* (more than 200 ms after exiting is
missed — bounded by design, and worth confirming it is only the *tail* of the explanation that can be
lost, never the exit code); a daemon that sends `fatal` and then *does* become ready (the fatal text is
then reused at its later death — is that honest or stale?); a `fatal` frame with a megabyte traceback;
`ready` after the drain timer, i.e. a daemon that starts late but under the ready timeout.

### R2-07 — decided: disclose, do not re-architect the capture

**The decision.** Option (a), one capture pipe per exec, is the exact fix and was rejected. The host
cannot receive a daemon-side pipe without fd passing; the workable shape is a per-exec pipe the *daemon*
pumps into the shared capture stream with its own reader — which needs a thread or a loop that is
guaranteed to run while the cell runs. A cell that blocks in C (`subprocess.run` of a chatty command, a
tight printing loop) does not run the loop, the 64 KB pipe fills, the cell blocks on write, and the
channel deadlocks. Replacing "a timeout never kills a cell" with "a chatty cell can hang the channel" is
a worse trade than the papercut. So: keep the two pipes, and be exact about what is claimed.

What is now claimed, in code and in `DESIGN.md`:

- bytes that arrive **while no block is open** are attributed to the exec whose block closed last, capped,
  with a header that says *whose log this is* rather than implying what caused it ("output that arrived
  after this cell ended: from something the channel left running, not from a cell");
- seeing such bytes sets a per-channel flag, and **every later result from that channel** carries a note
  that the channel has produced output no cell asked for, so its lines may not all be from this cell.
  That is the first thing the host can actually know, and it is the state the audit's repro is in;
- bytes that arrive **while a block is open** are not attributable at the descriptor level, and nothing
  now pretends otherwise.

*Pass 3 should try:* the harder repro — an orphan that writes *only* during a later cell's block, so no
between-block evidence is ever seen. The note will not appear and the contamination will be undisclosed;
that is the accepted limit of shape (b), stated here and in `DESIGN.md`, not an oversight. If you can find
a *cheap* signal for it (something the daemon already knows), argue for it here rather than coding the
pump. Also try: the forward walk pass 2 described (does the header now read as attribution rather than
causation?); the 256 KB cap with an orphan that writes for a minute; whether a sticky note misleads for a
channel whose orphan died an hour ago (it over-discloses; that was the cheaper side of the trade).

### R2-08 — dead code deleted, the fact moved into text

The unreachable `exec.killRequested ? "interrupted" : "dead"` assignment is gone; `Exec.finalize` owns
the status and death outranks everything (R1-06). `killRequested` is still set, and where it matters it is
now *said*: a cell that died with an interrupt in flight gets a death note ending "…shortly after an
interrupt was requested for this cell". Pinned with a stub interpreter that exits on SIGINT
(`l-intdeath`), asserting `status: dead` **and** the interrupt in the text — the model must not read a
successful stop as a crash, or a crash as a stop.

*Pass 3 should try:* `bg_stop` on such a daemon (what does the task listing say?), and the ordinary case
where the interrupt works (status `interrupted`, no death note).

### R2-09 — the group kill's exception is now written down

Stated in `channel.ts`'s header, in `DESIGN.md`, and in the `kill` parameter description ("… except any
that moved into a process group of their own, which the kill cannot reach"). The kill itself is unchanged:
walking a process tree to signal descendants is worse than the hole. `test/resilience.test.ts::R2-09`
still pins the escape and still says to update it if the kill ever gets smarter.

*Pass 3 should try:* `setsid(2)` / a double fork from a cell, and whether any *other* promise (README,
prompt section) still says "everything the cell started" without the exception.

### R2-10 — the model-facing text caught up

`SECTION_LINES` now says channels are capped (default 4), that at the cap the idlest is retired with its
variables and that a new one is refused when they are all busy, and it names `bg_stop {kill: true}` next
to plain `bg_stop`, with what it takes down. Two new `promptGuidelines` carry the cap and the two-stop
distinction. Asserted in `test/prompt.test.ts`. "default 4" is worded that way on purpose: the section is
rendered per session and the cap is read per creation, so an env override makes the number different, not
the sentence wrong.

*Pass 3 should try:* whether the section is still byte-stable inside a session (prompt cache) after a
channel is created or killed — only `session_start` may change it; and whether the guidelines have now
drifted from the section (they repeat the same two facts in different words).

### One test changed, with a stated reason

`test/honesty.test.ts::R2-02` read `expect(shown, message).toBeLessThan(MAX_OUTPUT_CHARS + 5_000)`.
`shown` is a string, and vitest's `toBeLessThan` throws `TypeError: actual value must be number or
bigint` on a string — so that assertion never compared anything, before or after the fix; the failure
pass 2 reported for it is that TypeError, visible in its own baseline log. Changed to
`expect(shown.length, …)` with the bound and the message identical. The sibling test in the same `describe`
already used `.length`, which is presumably the shape intended. This is the only line of pass 2's tests
that was touched, and it strengthens rather than loosens the assertion (it now actually asserts).

### Probed and left alone, on purpose

- The 64 MB `MAX_FRAME_BYTES` hole (a `code` frame so large the daemon drops it as `_overlong`, leaving
  the channel looking busy forever) is still unreachable through the tool layer, and still wants a
  host-side refusal rather than a daemon change.
- `structuredContent.output` holding the capture but not the traceback (see R2-02).
- The nonce global now also holds the appended full traceback when one was shortened. A cell slicing it
  gets capture + traceback; harmless, and the alternative is a second file per exec.
---

## Pass 3 — 2026-11-01 (tester)

Gate at the start: green — `tsc`, `biome`, 123 vitest, 47 pytest; re-run before starting, identical.
Gate at the end: `tsc` and `biome` green, **153 vitest (139 pass, 14 fail)**, **47 pytest green**. Every
vitest failure is a test this pass wrote to hold a finding below (`limits` 4, `names` 4, `lifecycle` 3,
`prompt` 2, `resilience` 1); two full runs back to back produced the same 14 failures and the same pass
count, no flake. `src/` and `python/` are untouched by this pass, so
no real-`pi` smoke was owed (the pass-2 fixes' smoke is the current evidence).

New file `test/limits.test.ts`; new tests in `test/names.test.ts`, `test/lifecycle.test.ts`,
`test/prompt.test.ts`, `test/resilience.test.ts`, `test/cap.test.ts`, `test/capture.test.ts`,
`test/format.test.ts`, `test/honesty.test.ts`, `test/reload.test.ts`. New tool:
`scripts/mutation-audit.sh` — it breaks one already-fixed defect at a time and runs the file that should
notice (the "is this fix actually pinned?" check; run it after your fixes and add a line for each one). Nothing was deleted or weakened; the only removed
lines in the diff are two header comments and one import, each replaced by a wider version of itself.

Ten findings: **one BUG, nine PAPERCUTs.** No BLOCKER. Seven of the ten are in the pass-2 fixes
themselves (R3-01 sits where R2-02 sits, R3-03/R3-08 in R2-04, R3-04 in R2-03, R3-05 in R2-08, R3-07 and
R3-10 in R2-06/R2-07, R3-09 in R2-02).

### R3-01 — BUG — three fields the host pastes into an answer are not bounded by anything

The 50 000-character promise was extended to the traceback by R2-02, and that part holds (see the
re-check table). But the answer is not only capture plus traceback, and two of the remaining pieces are
text whose size a cell controls:

1. **the daemon's note ring.** Every `log` frame the daemon sends is stored verbatim in `Channel.note()`,
   a ring capped at 40 *entries*, and `deadResult` pastes the last six under "daemon said:". A cell can
   put an arbitrary string into one frame — the SIGINT-disposition warning quotes whatever the cell's own
   handler is called, and `disposition_name` returns its `__name__`:

   ```python
   f = lambda *a: None
   f.__name__ = 'x' * 300_000
   signal.signal(signal.SIGINT, f)     # the next cell logs "a cell left SIGINT on xxxxx…; restored …"
   ```

   `test/limits.test.ts::R3-01` — the dead-channel result is **300 240 characters**. Four such frames
   also park ~1.2 MB of strings in the host for the life of the channel: the same "capped by count, not
   by bytes" shape R1-08 found in `loose`.

2. **`definitions`.** The daemon caps the *list* at 100 names (`sorted(...)[:100]`) but a Python
   identifier may be 4095 characters, and the names go into the answer's "defined by this cell:" note and
   into `details.definitions`. Thirty 3001-character names — `exec(n + " = 1")` in a loop, which is what
   generated code does — make the answer **90 262 characters** (`R3-01: and cannot do it with the names a
   cell bound`). Nothing downstream catches it, exactly as in R2-02.

3. the same names reach the **history file** (`definitions.slice(0, 20)`, unbounded each) and from there
   the **prompt section** of every later session (`definitionHint` quotes six of them): one cell took the
   section from **2 037 to 17 450 characters** (`R3-01: and those names do not end up in the prompt the
   next session starts with`; `registration.test.ts` counts *lines*, so it does not see it). That text is
   sent with every request of every later session, so it is the copy that costs the most.

Suggested fix: one place that bounds model-facing quoting. `oneLine(name, 60)` per definition plus
"…and 97 more"; each note entry clipped (`oneLine(text, 500)`) with the daemon's own log named as the
place for the full text; keep `details.definitions` as the raw list (a program reading it is not the
answer's size problem) or clip it too — the tests only require that the answer still *says* what the cell
defined (`"defined by this cell"` in the result, `"defined:"` in the section).

### R3-02 — PAPERCUT — a channel name that begins with a dash cannot start a channel at all

The daemon is spawned as `-m replmode --channel <name> --log <path>`, and argparse refuses to take a
value that starts with `-`:

```
channel "-r3-dash" could not start: the Python process behind channel "-r3-dash" ended (exit code 2)
usage: replmode-daemon [-h] [--channel CHANNEL] --log LOG [--cwd CWD]
replmode-daemon: error: argument --channel: expected one argument
```

`test/names.test.ts::R3-02` runs one cell on a channel named `-r3-dash` and gets that. The model sees a
usage dump and a start failure for a channel it named legitimately; `--help` as a name is worse (the
daemon prints its help onto the *protocol* fd and exits 0). The file-name side is safe —
`channelFileStem` never emits a leading dash — so this is purely argument passing.

Suggested fix: pass the name as one token: `"--channel=" + start.name`. (A name whose *first* character
is a dash is otherwise legal here: `-` alone already works, because argparse treats a bare `-` as a
value.) A test that runs a cell on `"-x"` and `"--help"` is the pin.

### R3-03 — PAPERCUT — `channelFileStem` is not one-to-one: a digested stem is itself a usable name

`names.ts` keeps a name verbatim when it is already a usable file name, and appends `-<10 hex>` otherwise.
`-` is a usable character, so the digested stem of one name is itself a name that is kept verbatim, and
the two channels land on the same three files:

```
channelFileStem("r3-dig/x")            →  "r3-dig_x-f395bbcba5"
channelFileStem("r3-dig_x-f395bbcba5") →  "r3-dig_x-f395bbcba5"
```

No brute force is needed — the collision is by construction, and the trigger is a model that copies a
file name it saw (the daemon log path is quoted in results; the stem appears in `IPYTHONDIR`) back into
`channel`. Then two live daemons write one daemon log, one `history.sqlite` has two writers, and — the
observable half — they append to one history file, and `lastHistoryByChannel` reads one record per file,
so one of the two channels is never reported as lost.

Repro: `test/names.test.ts::R3-03` (the fixed-point property, phrased so it fails only while the hole is
open) and `R3-03: keeps the history of two such channels apart` (channels `r3-own/x` and
`r3-own_x-b0122655c9` leave one history file behind and only one note).

Suggested fix, any of these keeps the existing `^[a-zA-Z0-9_-]+$` / ≤ 60-character assertions: append the
digest to a verbatim name that *looks* digested (`/-.{10}$/` of hex); use a separator that a usable name
can never contain (`.` is unsafe, so it cannot appear in a verbatim name — would need the regex
assertion widened); or always append a digest. The header comment's claim that the digest "makes the
mapping one-to-one" should then say *how*.

### R3-04 — PAPERCUT — the capacity refusal blames busy channels when the occupiers are still starting

R2-03's fix made an in-flight creation occupy a slot, which is right, but the refusal it produces is the
old text: with `PI_REPLMODE_MAX_CHANNELS=1` and a daemon that has not reported `ready` yet (a wedged
environment build — the R1-11 case, up to 120 s), a second call is told

```
all 1 pi-replmode channels are busy and the cap (1, set with PI_REPLMODE_MAX_CHANNELS) is reached:
let a background task finish, stop one with bg_stop, or free a channel with bg_stop {kill: true}
```

Nothing is running, there is no task id to hand to `bg_stop`, and the truth — a channel is still coming
up — is the one thing the model could act on (wait, or kill that channel by name).
`test/lifecycle.test.ts::R3-04` holds the wording.

Suggested fix: `makeRoom` knows which names are starting; say which (`channel "x" is still starting and
the cap (1, …) is reached: wait for it, or free a channel with bg_stop {kill: true}`), and keep the
"all N are busy" sentence for the case where they really are.

### R3-05 — PAPERCUT — `bg_stop` reports "stopped (dead)" and never says the channel went with the cell

R2-08 put "…, shortly after an interrupt was requested for this cell" into the death note of a
*foreground* call. The background path never reads `exec.deathNote` at all: when the interrupt is what
took the daemon down — a cell that installs `signal.signal(SIGINT, lambda *a: os._exit(7))`, an extension
that dies on the signal — the answer is

```
task repl-gjpfzfi7 stopped (dead).
Log: /tmp/…/repl-gjpfzfi7.log
```

which reads as an ordinary stop of an ordinary task, while `bg_stop`'s whole promise is "the cell dies and
the channel and its variables stay intact". The model reaches for its variables against a fresh daemon.
Repro: `test/resilience.test.ts::R3-05` — the next call is `[new channel]` plus a `NameError`, and the
stop answer mentions neither the channel nor the interrupt.

Suggested fix: in `bgStop`'s settled-after-interrupt branch, append `exec.deathNote` (and the "variables
are lost" line) whenever `exec.deathNote ?? exec.channel.closed` says the channel went. One line, and the
task listing already says `dead`.

### R3-06 — PAPERCUT — the prompt surface still promises the group kill reaches everything

R2-09 wrote the exception down in `channel.ts`, `DESIGN.md`, the `kill` parameter description and the
README. R2-10 then *added* two more copies of the promise, without the exception:

- `SECTION_LINES`: "`bg_stop` with `kill: true` takes the whole channel down instead — that also ends the
  servers, builds and subprocesses its cells started, and loses every variable in it."
- `promptGuidelines` for `run`: "…`bg_stop {kill: true}` takes the channel down and ends the processes
  its cells started."

The section and the guidelines are what a model reads every session; the parameter description is what it
reads at the moment of the call and is the one place that is honest. `test/prompt.test.ts::R3-06` holds
both, and its own existing assertion (`/servers, builds and subprocesses/`) means the wording has to keep
that phrase — e.g. "…its cells started (except any that moved into a process group of their own, which the
kill cannot reach)".

### R3-07 — PAPERCUT — a failed start sends the model to a daemon log that does not have the daemon's output

`reportStartFailure` cuts the explanation at 3 000 characters and, when it does, appends "the daemon's
full output is in `<daemon log>`". That pointer is wrong twice:

- the daemon opens its own log file, and an interpreter that dies before `python -m replmode` runs never
  opens it — the file does not exist (`test/lifecycle.test.ts::R3-07` asserts the named path exists and
  gets `false`);
- even when it exists, the log holds `log` frames, never the capture stream, which is where the
  interpreter's traceback arrived. The middle of the complaint is held only in the host's 64 KB `loose`
  buffer, and the bytes past that are dropped with `looseDropped` counted but never mentioned here.

Adjacent, and worth fixing in the same pass: `writeToSink`'s cap loop (`while (looseBytes > cap &&
loose.length > 0) loose.shift()`) removes the *only* element when one chunk is bigger than the cap, so a
bursty interpreter can lose nearly all of its own complaint. That is not deterministic in a test (node
hands the pipe over in ≤ 64 KB reads), but it is visible in practice: five runs of the same stub gave
results of 2 268, 1 333 and 2 268 characters for a 360 KB complaint, only one of which had the pointer.

Suggested fix: when a channel fails to start, the host *writes* what it received into
`this.daemonLogPath` (it has the bytes) and points at that; if the pointer is kept conditional, it must
also say how much was dropped. The cheap honest shape is one file the model can `open()` and read.

### R3-08 — PAPERCUT — two history files can remember one channel, and the stale one can win

R2-04's claim that an old history file "is still read correctly because the record inside it carries the
real name" is true — `test/names.test.ts` pins it green — but it means a channel can now have two files:
`a_b.jsonl` from before the naming change and `a_b-<digest>.jsonl` after. `lastHistoryByChannel` sets a
record per file with no tie-break, so whichever entry `readdirSync` happens to return last wins, and the
note can quote a cell from before the upgrade instead of the newest one. Repro:
`R3-08: and when two files remember the same channel` — two rounds with the file names swapped, so one of
them is guaranteed to put the stale record last; it loses to it (`expected 'stale_cell_marker = 1' to
contain 'newest_cell_marker'`).

Suggested fix: keep the newest record by `ts` when a channel appears in more than one file (the files are
few and the records are dated).

### R3-09 — PAPERCUT — the truncation note's totals go stale the moment the traceback is appended

R2-02's escape hatch writes the full traceback into the exec log. That is the one truncation in this code
that changes the file the notes point at, and `countOutput` ran *before* it: for a 9 MB capture and a
300 KB traceback, the answer says `output truncated: showing 29 940 of 9 045 120 characters` while the
file it sends the model to (`full output and traceback: <path>`) holds 9 345 400. The model is told one
number for a file of another size — the R1-09 complaint, at the scale of the traceback.
Repro: `test/limits.test.ts::R3-09`.

Suggested fix: take the totals after appending (or add the appended length to them — `appendNote` returns
nothing today; it could). The note's arithmetic ("N characters not shown") is unaffected.

### R3-10 — PAPERCUT — the startup complaint is labelled as a cell's late output

The bytes an interpreter writes before its first block opens are held in `loose` and, if the daemon dies
before any block opened, dropped into the last exec's log by `flushLoose` — through `Exec.lateWrite`,
which is the right call for the *writing* (it appends by path, so it survives a closed fd, and it caps the
volume) and the wrong one for the *words*, because `lateWrite` narrates:

```
[new channel "l-label": python 3.14.0, ipython 9.0.0, cwd /, pid 0, started in 1ms]

[output that arrived after this cell ended: from something the channel left running, not from a cell]
STARTUP-NOISE-BEFORE-ANY-CELL

[the Python process behind channel "l-label" ended (exit code 6)]
```

No cell ended; no cell ran. And the bytes are the interpreter's own startup complaint, so "from something
the channel left running, not from a cell" is not merely unproven here — it is the wrong story, and the
model is handed a phantom background process to go looking for. This is exactly the caution R2-07 wrote
into DEV.md about that header, violated at its one other call site.
Repro: `test/lifecycle.test.ts::R3-10` (the same stub as the passing test above it, which pins that the
bytes themselves are not lost).

Suggested fix: let `Exec.lateWrite` take the header (or add a sibling), and have `flushLoose` label these
bytes as what they are — output from before the first cell ran. The cap and the append-by-path stay.

### Re-checking pass 2's fixes, at the fix

| fix | what pass 3 tried | result |
| --- | --- | --- |
| R2-01 | a windowed log whose **last line is 3 MB** (end-to-end and unit); a window that is one oversized line with the file's `totals`; the single-line fallback in window coordinates; `countOutput`'s "at least" floor next to a windowed read | **held** — three new passing tests, and all three catch the mutation that puts the tail cut back into file coordinates |
| R2-02 | recursion *plus* a 200 000-character message (with `sys.setrecursionlimit`); 9 MB of capture and a 300 000-character traceback in one answer (both cuts live, both notes, both reachable from the log and the global); a traceback that fits (not cut, capture keeps the rest); the boundary where the capture eats the floor | **held**, except R3-09 (the note's totals go stale) and the fact that the *evalue* clipping was unpinned (see the mutation table) — now pinned by a new passing test over `details.evalue`, `structuredContent.error.evalue` and the task listing |
| R2-03 | a burst at a cap of **1**; a creation that *fails* and whether the slot comes back (`R2-03: a channel whose daemon dies on the way up gives its slot straight back`, passing); the refusal's status in both views; a burst where every refused answer must not say "could not start" | **held** — the arithmetic is right at 1 and after failures; the wording is R3-04 |
| R2-04 | a name that *is* another channel's digested stem; unicode (`éclair`), empty, 60-character and dash-containing names; the old-naming history file being read after the upgrade; traversal via the daemon's `--log` argument | **held** for the upgrade path, the profile/log/path naming and liveness; **broken** by construction (R3-03) and at the *argument* level (R3-02) |
| R2-05 | every path's `details.status` against its `structuredContent.status` (new passing test); the declared optionality | **held** |
| R2-06 | a complaint that arrives **3 s late** from a process the daemon left behind, with the capture pipe held open; a `fatal` frame followed by a real `ready`; a daemon that dies before its first boundary marker (the `flushLoose` path with an exec) | **held** — the exit code survives, the call does not wait on the pipe, a stale `fatal` is not pasted into a call that worked, the startup bytes are not lost — but the pointer it emits is R3-07 and the header those bytes get is R3-10 |
| R2-07 | the sticky note surviving a `/reload` (new passing test); whether anything benign sets it (the daemon writes nothing to the capture stream between cells, so only a real second writer does); the accepted during-a-block limit | **held**, still honest, still over-disclosing only where it says so. Cheap signal for the accepted hole, argued below |
| R2-08 | the ordinary interrupt (no death note, `interrupted`) and the interrupt-that-kills-the-daemon through `bg_stop` rather than an abort | **held** for the foreground; the background path lost the fact (R3-05) |
| R2-09 | `start_new_session=True` still escapes (its own test still pins it); every *other* place the promise is made | **held**; README and `channel.ts` carry the exception, the prompt surface does not (R3-06) |
| R2-10 | the section's bytes across creating and killing a channel; the cap facts in the section and guidelines | **held** — byte-stable inside a session; only `session_start` touches it |

**Mutation check** (`scripts/mutation-audit.sh` — break the fix, see who notices). Every line but two were
caught by pass 2's own tests:

| mutation | caught by |
| --- | --- |
| `channelFileStem` never appends a digest | `names.test.ts` R2-04 ×2 |
| `makeRoom` ignores `starting` | `cap.test.ts` R2-03 (and the new cap-1 test) |
| `tracebackBudget = 0` | `honesty.test.ts` R2-02 ×2 |
| `flushLoose` empties `loose` when no exec ever ran | `lifecycle.test.ts` R2-06 ×2 |
| the `fatal` frame is not kept in `fatalNote` | `lifecycle.test.ts` R2-06 |
| the lost-channel note keyed by the file stem again | `names.test.ts` R2-04, and the new old-naming test |
| the death note stops mentioning an in-flight interrupt | `lifecycle.test.ts` R2-08 |
| `truncateMiddle`'s tail cut back into file coordinates | `format.test.ts` R2-01 ×3 |
| `RUN_OUTPUT` makes `output`/`truncated` required again | `honesty.test.ts` R2-05 |
| **`oneLine(evalue, 500)` removed — survived pass 2's own suite** | nothing of pass 2's; now caught by a new passing test over `details.evalue`, `structuredContent.error.evalue` and the task listing |
| **`Exec.lateWrite` in `flushLoose` back to `Exec.write` — survived, and legitimately so** | nothing can catch it: the only reachable case is a daemon that dies before its first boundary marker, where the exec's log fd is still open (`flushLoose` runs before `finalize`), so both calls append. What `lateWrite` changes there is the cap, the header, and safety-if-the-order-ever-changes — and its header is wrong in that case, which is R3-10 |
| `failure()`'s status chosen differently — survived | nothing; see "left alone" — the enum has no value for "your arguments were invalid" |

Pass 2's "one test changed": **accepted**. I reproduced the claim directly — `expect("abc").toBeLessThan(5)`
raises `TypeError: actual value must be number or bigint, received "string"` in vitest 5, so that
assertion never compared anything, and `.length` is the same bound, now actually evaluated. The general
form of that bug is self-revealing in a green gate (a type error fails the test), which is why the search
here went through mutations instead. One vacuity worth noting, not filed: `cap.test.ts`'s R2-03 counts
live *pids*, so it passes vacuously if no `details.pid` is reported; the new cap-1 test asserts at least
one refusal and that every pid is gone afterwards, and the same guard could be added to pass 2's.

### Probed and left alone

- **A cheap signal for R2-07's accepted hole.** The pump is still wrong (the deadlock argument holds).
  But there is a disclosure that costs nothing and attributes nothing: at `_end` (or from the host, which
  knows the daemon's pid) read `/proc/<pid>/task/*/children`; if the list is not empty when a cell
  finishes, the channel has live descendants, and that can be said in the *next* results — "this cell
  left processes running; their output can appear in any later cell's". It is a different claim from
  attribution, Linux-only, and heuristic, but it closes the disclosure gap in the case the audit's repro
  is in (an orphan that writes only during a later block), without touching the capture.
- The note ring is not pasted into a *finished* result, only a dead one, so R3-01's first half cannot
  contaminate a normal call.
- `truncated: true` when only the traceback was cut, with `structuredContent.output` complete: still the
  accepted asymmetry ("`structuredContent.output` is the capture"). A wrapper that wants to know which
  piece was cut has the notes.
- The banner and the notes ride ~500 characters above 50 000 (the cut budgets reserve only 100 for the
  note inside the text). The suite's `+5_000` slack encodes that deliberately; making the answer
  *exactly* bounded would mean reserving room for the notes, which would cut output for nothing.
- A windowed cut whose last line is oversized may return as little as 40 % of the tail budget — the
  cutter's floor, not a bug; the note reports the numbers that were really shown.
- `status: "dead"` for an empty `code` or an invalid `timeout` (the `failure()` path) is not a *channel*
  claim so much as the enum lacking a "rejected" value. Pass 2 settled the enum; not re-opened.
- Housekeeping, not filed: `Channel.readOutput`, `Exec.outputTruncated`, `ReplManager.liveChannelNames`
  and `format.ts`'s `STRUCTURED_OUTPUT_MAX_BYTES` are dead (the constant's comment claims it caps
  `structuredContent.output`, which uses a literal instead — and that `slice(0, 1_048_576)` is a no-op
  because the text it is applied to is already ≤ 50 000). R2-08's lesson: either use it or delete it.
- The accepted limits this pass was told not to re-file, re-checked and still accepted: per-exec capture
  pipes (deadlock), the sticky out-of-band note (over-disclosure is the cheaper side),
  `structuredContent.output` excluding the traceback, and the 64 MB `MAX_FRAME_BYTES` `_overlong` hole.

### Handoff to the fixer

Order of work that keeps the tree comprehensible: R3-02 and R3-03 first (both are `names.ts`/argv, one
test file, and R3-03 changes stems, so do it before anything that reads history file names); then R3-08 in
the same file; then the R3-01 bounding (one helper, three call sites, and it must not remove the
"defined by this cell" note or the "defined:" line in the section — those are asserted by these tests and
by `registration.test.ts`); then the two wording findings (R3-06, R3-04) and R3-05, which is one line in
`bgStop`; R3-07 and R3-10 last, because they touch the start-failure path where R2-06's tests live.

What each fix must not break:

- R3-03: `names.test.ts` pins that stems match `^[a-zA-Z0-9_-]+$` and stay ≤ 60 characters, that `main`
  keeps the readable name `main`, and that unicode names get the digest. A fix that always appends a
  digest breaks the second of those; a fix that widens the safe-character set breaks the first — the
  AUDIT's first suggestion (digest names that already look digested) keeps all three.
- R3-01: `honesty.test.ts` requires the answer to keep saying what it shortened and where the rest is; a
  fix that answers "the definitions are too long to show" without a pointer is a new finding.
- R3-06: `prompt.test.ts` asserts `/servers, builds and subprocesses/` survives in the section, and
  `kill` 's parameter description must keep `/process group/`. Adding the exception to the section makes
  its bytes change once — that is fine (the section is allowed to differ across sessions), but the new
  "byte-stable while channels come and go" test pins that nothing *runtime* moves it.
- R3-07: `lifecycle.test.ts`'s R2-06 tests pin the exit code, the 3 000-character bound and that a late
  complaint does not hang the call. Writing the captured bytes into the daemon log path must not steal the
  daemon's own file from a daemon that *did* start — the R3-07 stub never started, which is the case in
  question.
- R3-09/R3-10: both touch how an exec log is written; `capture.test.ts` and `format.test.ts` pin the
  numbers the notes quote and the windowed totals.

Then: `npm run check`, re-run `bash scripts/mutation-audit.sh` (add a line for each fix — a fix with no
mutation that dies is a fix with no test), and the real-`pi` smoke in DEV.md, since R3-02 and R3-07 touch
daemon startup and R3-01/R3-09 touch what a result carries. Afterwards, confirm no `python -m replmode`
process and no cell-spawned `sleep`/`bash` is left running.

## Pass 3 fixes — 2026-11-01 (fixer)

Gate at the start: `tsc`/`biome` green, **153 vitest (139 pass, 14 fail)**, 47 pytest — the fourteen
failures are pass 3's holding tests. Gate at the end: **green — `tsc`, `biome`, 164 vitest, 47 pytest**,
two full runs with the same result. All ten findings are fixed; the fourteen holding tests went green
untouched except one assertion that could not be satisfied by any working code, argued under
"One test changed (pass 3 fixes)". Eleven tests were *added* to pin the fixes themselves: the
whole-option channel names, the "no stem is a fixed point" property and the channel-name length cap
(`names` ×3), the startup buffer at the wire level (`lifecycle` ×1), the same arithmetic as pure functions
(new `test/buffers.test.ts`, ×4), and three more copies of the size bound (`limits`: `ename`, the history
file, the prompt section).

Real-`pi` smoke re-run (throwaway agent dir, thinking on for `qwen38-flash-next`): the DEV.md two-call
prompt answers 42; a channel named `-smoke-dash` starts and keeps state and its result still ends with
`[defined by this cell: values]`; `os._exit(3)` is reported with both death notes and the next call
starts a fresh channel; and the R3-05 path through the real tool layer answers

```
task repl-atfcf9ty stopped (dead).
the Python process behind channel "smoke-stop" ended (exit code 7), shortly after an interrupt was requested for this cell; the channel is gone and its variables are lost; the next run on it starts a fresh one
```

Afterwards no `python -m replmode` daemon and no cell-spawned child was left running.

Mutation testing, and the honest part of it: `scripts/mutation-audit.sh` grew from 12 lines to 32 and
gained a label filter (`bash scripts/mutation-audit.sh R3-0`), because a full pass is now 3m20s. The
**first full run showed three of my own fixes were not pinned**: the R3-04 wording (the *other* refusal
branch also mentions "starting", so the test was satisfied either way), R3-05 (the test never required
the word "variables"), and the two copies of the R3-01 definitions bound, which masked each other — with
either one clipped, the prompt-section test was happy. Fixed by adding assertions (`not.toMatch(/are
busy/)` and `toContain("l-occupier")` to R3-04, `/variables/` to R3-05) and two new tests (F3-03 pins the
history file, F3-04 pins the section quoting a file written by anything). Full re-run on the committed
tree: **30 of the 32 mutations die.** The two that survive are the two pass 3 itself recorded as
legitimate — `flushLoose`'s `Exec.lateWrite` → `Exec.write` (both append in the only reachable case;
what matters there is the header, which is now a separate mutation that does die) and `failure()`'s choice
of status (the enum has no "your arguments were invalid" value — accepted, not re-opened).

### R3-01 — every copy of a cell-chosen string is bounded where it is quoted

Four copies, three new bounds and one deliberate non-bound:

- **the note ring** (`Channel.note`): each entry is stored as `oneLine(text, 500)`. Bounding it at
  *store* time rather than at paste time also closes the memory half of the finding — four 300 KB frames
  no longer park 1.2 MB in the host for the life of the channel. The ring was already capped at 40
  entries; count and bytes are both bounds now. `deadResult` adds "each line is shortened; the daemon's
  own log is `<path>`" under the pasted lines.
- **the "defined by this cell" note**: `definitionList` quotes at most 25 names, each `oneLine(…, 60)`,
  and says `(…and N more)` instead of pasting the rest. The note is still there and still says what the
  cell bound, which is what `honesty.test.ts` and `run.test.ts` require of it.
- **the history file**: `definitionNames` keeps 20 names of at most 120 characters (`HISTORY_*`). This
  is the copy that outlives the session, so bounding it at write time is what stops a later session
  having to carry (or re-shorten) a 3001-character identifier.
- **the prompt section**: `definitionHint` shortens each of the six names it quotes to 60 characters —
  independently of the write-time bound, because a history file may have been written by an older build
  (F3-04 pins that case by writing such a file by hand).
- `details.definitions` stays the raw list. A program reading `details` is not the answer's size problem,
  and quietly handing it a *different* list than the channel really bound is its own kind of lie.

Two more fields of the same class, found while fixing it (mine, not the audit's):

- **F3-01 — `ename`.** `type("n" * 3000, (Exception,), {})` is a legal class and its `__name__` is what
  `ename` carries, into `details`, into `structuredContent.error`, and — the model-facing copy — into the
  task listing `bg_wait` prints as `failed (<name>)`. Clipped to 200 characters in all three, the same
  treatment `evalue` already had.
- **F3-02 — the channel name itself.** A caller can ask for a 500-character channel name; it is then
  quoted in every result about that channel and, through the history file, in the prompt section of every
  later session. `run` now refuses names over 200 characters. That is a *new* refusal path, and it is
  dressed like the other argument errors (`invalid channel name: …`, `status: "dead"` via `failure()`),
  which pass 2 already accepted as the enum's limit.

Where this is deliberately weak: the answer is still capture + traceback + notes, and the notes now have
up to ~3 KB of their own (six shortened daemon lines, the definitions note, the truncation notes), so the
total still rides a couple of KB above 50 000 — the suite's `+5_000` slack, unchanged. The numbers
(60 / 120 / 500 / 200) are chosen for legibility, not derived from anything. `oneLine` flattens newlines,
so a multi-line `log` frame becomes one line in "daemon said:".

*Pass 4 should try:* whether the *whole* model-facing surface is now bounded, not each field — a session
with 8 lost channels each quoting 6 names, and 300 history records on disk; the notification
`session_start` pushes (it lists every lost channel's name); the banner (`ready.cwd`, `python`,
`ipython` — host-chose, but check whether a cell can move `cwd` into it); `env.dir`; `info.code` in the
task listing (400); whether the 200-character cap on channel names breaks something legitimate (a model
that names a channel after a long path); whether `details.definitions` being raw while the note is
shortened is a problem for a consumer (it is the documented asymmetry — argue it if you disagree).

### R3-02 — the channel name travels as one argv token

`spawn(…, ["-m", "replmode", "--channel=<name>", "--log=<path>", "--cwd=<cwd>", …])`. One token per
option, so argparse cannot read the value as another option; `--log` and `--cwd` moved to the same shape
while I was there. Pinned for `-r3-dash`, `-x`, `--help` and a bare `-` — `--help` was the worst case
because it printed the daemon's usage onto the *protocol* fd and exited 0, which the host reads as a
daemon speaking nonsense.

Deliberately weak: the daemon still parses its own arguments, so the safety is "the value is glued to its
option", not "arguments are not parsed at all". `--cwd` comes from `ctx.cwd`, not the model.

*Pass 4 should try:* a channel name that is empty after trimming (falls back to `main`), one that is
exactly `--`, one containing `=` inside (`--channel=--channel=x` is a name, check what the daemon
records), a name with a newline or unicode combining characters, and whether any *other* consumer of the
name treats a leading dash as an option — the file names (`-x.log`, joined to an absolute dir, safe),
`IPYTHONDIR`, the history file, and anything that shells out with a path built from a stem.

### R3-03 — a name that looks digested is never used verbatim

`channelFileStem` keeps a third rule: `LOOKS_DIGESTED = /-[0-9a-f]{10}$/`, and a name matching it gets
the digest appended like any unsafe name. That is what makes the mapping injective rather than merely
unlikely to collide: the stem this function produces can no longer be a name that maps to itself, so
`r3-dig/x` and `r3-dig_x-f395bbcba5` get different daemon logs, history files and IPython profiles. I
took the audit's first suggestion (digest what already looks digested) over the alternatives: always
digesting breaks the assertion that `main` keeps its obvious file name (and every human-read file with
it), and a separator no usable name can contain would widen the `^[a-zA-Z0-9_-]+$` assertion the same
file pins. The header comment now states the three rules and says *how* it is one-to-one, and adds the
consequence: **the function is not idempotent, and nothing may feed a stem back into it** — every call
takes the channel's real name (checked: nothing does).

Deliberately weak: a legitimate name that happens to end in `-<10 hex>` (`build-deadbeef00`) now gets a
second digest — ugly file names, still within the 60-character budget (max stem is 51: 40 readable +
`-` + 10). Injective up to the 40-bit digest, as before.

*Pass 4 should try:* a chain — `channelFileStem` applied three times, and whether any two links can
meet; names that are exactly 40 characters and look digested; three history files for one channel across
the two naming schemes (that is R3-08's tie-break, so test them together); whether anything in `src/` or
the *daemon* still reconstructs a name from a stem; and 40-bit collisions in principle — say honestly how
many names a session can push through the tool before birthday collisions bite.

### R3-04 — the capacity refusal says which slots the starters hold

`makeRoom` now ends in `capacityRefusal(live)`. With nothing live at all, the refusal names the channels
that are still starting, says plainly that there is no task to stop and no idle channel to retire, and
tells the model to wait for the call that is starting. The "all N channels are busy" sentence is kept for
the case where N channels really are running cells — and when both are true, the starters are appended
("…`"x"` is also still starting").

Deliberately weak, and worth an audit opinion: **there is still no way to free a channel by name.** A
creation that wedges (an environment build, an interpreter that never reports ready) holds its slot for up
to `PI_REPLMODE_READY_TIMEOUT_MS` — 120 s by default — and `bg_stop` cannot reach it because it has no
task id. The wording is now honest about that; the model's only move is to wait. If pass 4 thinks that is
a finding rather than a limit, the fix is a tool-surface decision (a name-taking close, or a
`bg_stop`-by-channel), not a one-liner, so say what the surface should be.

*Pass 4 should try:* cap 1 with one live-busy channel *and* one starting (the mixed sentence — is it
readable and true?); a creation that fails while holding the slot (the slot must come back, already
pinned); `PI_REPLMODE_MAX_CHANNELS=0` or garbage (falls back to 4 — is that the right fallback?); five
calls on the *same* new name at once; and whether the new `not /are busy/` assertion hides a case where
saying "busy" would have been correct.

### R3-05 — `bg_stop` reads the death note

The settled-after-interrupt answer moved into `stoppedResult`, which appends
`exec.deathNote ?? (channel.closed ? channel.deathNote : undefined)` plus
"the channel is gone and its variables are lost; the next run on it starts a fresh one". A plain stop of
a plain cell gains nothing. This is the fact R2-08 put into the *foreground* death note; the background
path had simply never looked.

Deliberately weak: `details`/`structuredContent` still only say `status: "dead"` — the text carries the
rest. And the note proves the channel died by the time the stop settled; it cannot prove the interrupt
caused it beyond the "shortly after an interrupt was requested" phrasing the channel already owns.

*Pass 4 should try:* `kill: true` on a channel that was already gone (the "(the channel was already
gone)" branch and whether the two sentences contradict each other); a task whose channel died *after* the
task settled; `bg_stop` for an exec that has been pruned from `execs`; and whether "stopped (dead)" plus
a death sentence is one report too many for a model to parse.

### R3-06 — the model-facing promise carries its exception

`SECTION_LINES` now reads "…it ends the servers, builds and subprocesses in the process group it kills (a
child that left that group survives), and it loses every variable in the channel", and the `run`
guideline ends "…except any that moved into a process group of their own". Both keep the phrases
`prompt.test.ts` pins (`servers, builds and subprocesses`, `process group`). The section's bytes change
once with this — allowed: only a session boundary moves it, and the byte-stability test pins that nothing
runtime does.

Deliberately weak: it is still prose in four places (`channel.ts` header, DESIGN, README, the `kill`
parameter) plus two new ones. `RUN_DESCRIPTION` says nothing about the kill at all, which I left alone —
the description is already long and the guideline carries the fact.

*Pass 4 should try:* read all six places and decide whether they now agree, and whether the section is
getting long enough that its facts stop being read (its stable part is ~1 800 characters now, up about
60 from this fix).

### R3-07 — the pointer names a file that holds the bytes, and the buffer trims instead of dumping

`reportStartFailure` now: cuts the explanation as before; if it cut, calls
`writeFailedStartOutput()`, which appends what the host received (the `loose` capture, the `fatal` frame
text, and a "[… N bytes … were dropped …]" line) to `this.daemonLogPath`, and points at it; if the write
fails, says so plainly ("the rest of the daemon's output was dropped and could not be saved") rather than
naming a file that does not have them. The answer also discloses `looseDropped` in its own words, so the
model is not told "the full output is here" about a file that is missing its middle. Gated on
`this.ready === undefined`: for a channel that *did* run, that path is the daemon's own log and these
bytes belong in the exec log instead (that was the pass-3 constraint, and it holds —
`flushLoose`/`finalize` still own them).

The `loose` cap stopped dropping whole chunks: `keepNewest(chunks, cap)` trims inside the oldest chunk, so
the newest `cap` bytes always survive — which is where the line saying *why* the interpreter died is. The
`looseBytes` field is gone (derived from the chunks). The audit said this was not deterministically
testable; it mostly is, in the safe direction: `test/buffers.test.ts` pins the arithmetic exactly, and a
new `lifecycle` test writes two 40 KB bursts and asserts the marker at byte 30 000 survives and the
disclosed drop is under 20 000 — that fails on whole-chunk dropping and, if node happens to hand the pipe
over in finer pieces, both versions keep the same bytes and the test still passes on correct code.

Deliberately weak: bytes past 64 KB are still gone (the cap is the point), now exactly the oldest ones,
counted in both the answer and the file. The report still waits only `STDIO_DRAIN_MS` (200 ms) or for the
stdio to close, so a writer that appears afterwards is not in the file. Writing is best-effort: a
read-only agent dir turns the pointer into the honest "could not be saved" sentence.

*Pass 4 should try:* make the write fail (a read-only `replmode/daemon` dir) and see whether the answer
is still useful; a daemon whose complaint arrives after `close`; two failed starts on the same channel
name (does the second clobber or sensibly append to the first's file?); a stub that writes its complaint
to **stdout**, i.e. the protocol fd (does the report still say something — that path goes through
`frameBuffer`/`note`, and the note ring is now clipped to 500 characters per line, which is a R3-01 change
to a R2-06 path); the 360 KB single-write case; and the exactness of the disclosed drop number when
`CaptureSplitter` holds back a trailing partial sentinel.

### R3-08 — the newest record wins, whichever file it was in

`lastHistoryByChannel` normalises `ts` (a non-string becomes `""`, so a bogus record cannot beat a real
one) and keeps a record only if it is at least as new as the one it already had for that channel. The
upgrade path (`a_b.jsonl` before the naming change, `a_b-<digest>.jsonl` after) is what makes this
reachable; `readdirSync` order no longer decides what the model is told.

Deliberately weak: ordering is a string comparison of ISO stamps — same format, so correct for anything
this code writes, and a clock skew of a year is the same lie either way. Ties keep the record read later.

*Pass 4 should try:* three files for one channel, one with a torn tail, one with a bogus `ts`, one whose
record belongs to a *live* channel (it must not appear in the notes at all); a future-dated record;
whether `lostChannelNotes`'s 8-note window now drops the right ones; and a channel renamed between two
pi processes.

### R3-09 — the totals are taken after the traceback lands

`finishedResult` appends the full traceback to the exec log *first*, then calls `countOutput` on the file
and quotes those numbers (with `Math.max` against the cut's own numbers as a floor, and `at least` coming
from the fresh count when the scan cap bit). The note's "N characters not shown" arithmetic is untouched;
the cut itself is still decided against the text in hand (R2-01).

Why a re-count rather than `appendNote` returning its length: the log can also contain late-write headers
and a dropped-bytes marker, so "capture length + traceback length" would still not be the size of the
file the model is sent to. The cost is one more bounded scan (≤ 16 MB) on the path that already wrote
hundreds of KB.

Deliberately weak: the quoted total now counts the file, including the header lines the host wrote. That
is deliberate — the number describes the thing the pointer opens.

*Pass 4 should try:* a log with late output *and* a truncated traceback (does the note mislead about what
the extra characters were?); a log just over the 16 MB scan cap after the append (`at least` after a
second count); the log deleted between the count and the read; another writer appending between the count
and the answer; a traceback-only cut where the capture was tiny.

### R3-10 — startup bytes are labelled as startup bytes

`Exec.lateWrite(chunk, header = LATE_OUTPUT_HEADER)`; `flushLoose` passes `STARTUP_OUTPUT_HEADER`
("[output that arrived before any cell's output block opened: from the channel starting up, not from this
cell]"). The *writing* stays `lateWrite` — append-by-path so it survives a closed fd, and the 256 KB cap —
which is what pass 3's mutation table said was legitimate; only the words were wrong.

Deliberately weak: the bytes still land in an exec's log (it is the only place there is, and it is the
file the answer points at). "from the channel starting up" is provable for these bytes — they arrived
before the first block opened — which is more than R2-07 allowed for the late-output header, and the
distinction is exactly that.

The claim behind the wording: `loose` can only ever hold bytes from *before the first boundary of the
channel*, because once any block has closed, `lastClosed` is set and every later outside-a-block chunk goes
through the late path instead. So the startup header is true for everything `flushLoose` moves, including
the case where an earlier cell ran and a later exec died before ever opening a block.

*Pass 4 should try:* exactly that case (cell 1 answers, cell 2 dies before its opening marker — is what
lands in cell 2's log labelled honestly, and did the bytes between the cells really go to cell 1's log as
`channel.ts` says?); a daemon that writes startup noise *and* late output, so one log carries both headers;
and whether "from the channel starting up" over-claims when the writer was a process the *interpreter*
started during import.

### One test changed (pass 3 fixes)

`test/names.test.ts`, the R3-02 finding test: `expect(result.isError, …).toBe(false)` → `toBeUndefined()`.

That assertion could not be satisfied by any working code. The tool's contract — pinned **green** by
`test/background.test.ts:32`, `expect(result.isError).toBeUndefined()` — is that a successful `run` result
carries no `isError` key at all, which is pi's documented shape ("if provided, replaces the tool result
error flag"). So either the fix sets `isError: false` on success (breaking a passing test, which the rules
forbid) or the assertion is wrong. `toBeUndefined()` is the same intent and is stronger than
`not.toBe(true)`: it fails if the flag appears at all, with any value. The behaviour the test exists to
pin is pinned by the rest of it ("dash channel works" in the output) and by the new companion test over
`-x`, `--help` and `-`. Both the old and the new form fail on the unfixed code, so nothing about the
finding's pin got looser — and the mutation line for R3-02 still dies.

### Pass 3's own mutations, and what caught them

| mutation | caught by |
| --- | --- |
| the channel name is two argv tokens again | `names.test.ts` R3-02 ×2 |
| a name that looks digested is used verbatim | `names.test.ts` R3-03 ×3 |
| the refusal blames busy channels when the slots are starting | `lifecycle.test.ts` R3-04 (only after the added assertions) |
| `bgStop` never reads the death note | `resilience.test.ts` R3-05 |
| `bgStop` mentions the death but not the variables | `resilience.test.ts` R3-05 (only after the added assertion) |
| the section drops the process-group exception | `prompt.test.ts` R3-06 |
| the run guidelines drop it too | `prompt.test.ts` R3-06 |
| two history files, and the last one read wins | `names.test.ts` R3-08 |
| the daemon note ring is bounded by count only | `limits.test.ts` R3-01 |
| the definitions note quotes every name in full | `limits.test.ts` R3-01 |
| the prompt section quotes remembered names unbounded | `limits.test.ts` F3-04 (new) |
| the history file stores the names as they came | `limits.test.ts` F3-03 (new) |
| the truncation note quotes totals taken before the append | `limits.test.ts` R3-09 |
| startup bytes get the late-output header again | `lifecycle.test.ts` R3-10 |
| a failed start points at a file it never wrote | `lifecycle.test.ts` R3-07 ×2, R2-06 chatty test |
| the startup buffer drops whole chunks again | `lifecycle.test.ts` the new trim test |
| `keepNewest` keeps the oldest bytes | `buffers.test.ts` ×3 |
| `ename` quoted unclipped (result, and listing) | `limits.test.ts` F3-01 ×2 |
| a channel name of any length is accepted | `names.test.ts` F3-02 |

Unchanged from pass 3's table, still surviving on purpose: `flushLoose`'s `Exec.lateWrite` →
`Exec.write` (unreachable difference in the only case that runs — the header mutation above is the one that
matters), and `failure()`'s choice of status.

### Handoff to pass 4 (tester)

Pass 3 attacked pass 2's fixes; pass 4 should attack these fixes. What held and does not need re-proving
from scratch: the interrupt design (both paths), the group kill and its exception, the channel-cap
arithmetic under concurrency and failure, the out-of-band output note, the traceback's share of the limit,
windowed truncation coordinates, the name encoder's shape, the death note, and the history-file upgrade
path. Every pass-2 mutation line still dies.

Attack at the fix:

1. **R3-01's whole surface.** The finding was about fields; the claim now is that every *copy* is bounded.
   Build the largest prompt section you can (8 lost channels × 6 remembered names, 300 records on disk) and
   the largest answer you can (banner + capture + traceback + notes), and look for any remaining field a
   cell or a caller sizes: `ready.cwd` (can a cell change the banner's cwd?), `env.dir`, `info.code`,
   `torn`, the `session_start` notification, `logPath`s. F3-02 introduced a *new refusal* — argue it if it
   should not exist, and check it against a legitimately long channel name.
2. **R3-03's injectivity, chained.** Stems of stems of stems; grep for anything that feeds a stem back;
   three history files for one channel across the naming change (this meets R3-08).
3. **R3-07's new file.** Make the write fail; make the complaint arrive after `close`; fail twice on the
   same channel name; send the complaint to the protocol fd instead of the capture stream; check the
   disclosed drop count against `CaptureSplitter`'s held-back trailing bytes.
4. **R3-09's second count.** Late output plus a traceback in one log; a log past the scan cap; the log
   vanishing mid-report.
5. **R3-04's honesty vs. usefulness.** The mixed case (live-busy + starting) and the real question: a
   wedged creation holds a slot for up to 120 s and nothing can free it. If you call that a finding, say
   what the tool surface should offer.
6. **R3-02's argument passing** for names that are `--`, empty-after-trim, or contain `=`; and any place a
   channel name is interpolated besides argv.
7. **R3-10's header** — prove or break the claim that `loose` can only hold pre-first-boundary bytes,
   and put both headers in one log.

Re-run `bash scripts/mutation-audit.sh` (optionally with a label filter). Everything should die except
M6 and M11. And the smoke: R3-02, R3-05, R3-07 and R3-01's notes are now covered by real-`pi` runs —
re-run at least the DEV.md prompt plus one dash-named channel and one death, and check afterwards that no
daemon or cell child is left running.

---

## Pass 4 audit — 2026-11-01 (tester)

Gate at the start, at `8397049`: `tsc` and `biome` green, **164 vitest**, **47 pytest** — two full runs
back to back, same numbers, no flake. Real-`pi` smoke re-run first (throwaway agent dir, thinking on for
`qwen38-flash-next`): the DEV.md prompt answers 42; a channel named `-smoke-dash` starts, keeps state and
still ends with `[defined by this cell: values]`; `os._exit(3)` is reported with both death notes and the
next call starts a fresh channel; and `bg_stop` on a cell that exits on SIGINT answers the R3-05 sentence
in full. No daemon and no cell-spawned child was left running.

Gate at the end: `npm run fmt`, `tsc`, `biome` green, **185 vitest (172 pass, 13 fail)**, **47 pytest
green**, two identical runs. Every failure is a holding test this pass wrote: `limits` 2, `names` 1,
`lifecycle` 3, `resilience` 3, `cap` 1, `prompt` 3. Nothing in `src/` or `python/` was touched, and no
existing test was changed except one import line in `test/prompt.test.ts` (widened, not loosened) — the
whole diff is additions (`git diff | grep '^-'` says so). The smoke was re-run anyway because the pass-3
fixes are what this pass probed: same four prompts, same answers.

**Nine findings: two BUG, seven PAPERCUT. Eight of the nine are inside the pass-3 fixes** — R4-01 and
R4-02 in R3-01's bounding and R3-08's merge, R4-03 and part of R4-06 in R3-07's and R3-04's start path,
R4-04 and R4-09 in R3-05's `bgStop`, R4-05 in R3-04's refusal, R4-07 in F3-02's refusal. R4-08 is a
documentation claim the pass-3 notes made harder to defend.

### R4-01 — PAPERCUT — the record fields the prompt section quotes are bounded only where they are written

`lostChannelsLines` (`src/prompt.ts:51`) pastes `note.channel` and `note.code` **raw** into a line of the
section, and `session_start` pastes every lost channel's name into one notification
(`src/index.ts:168`). The definitions of the same record are clipped twice — at the write
(`definitionNames`, `manager.ts:1010`) and again at the quote (`definitionHint`, `prompt.ts:57`) — and F3-04
exists precisely because "a history file may have been written by a build that did not clip". The channel
name got the opposite treatment: bounded **only** on the write side, by F3-02's refusal
(`manager.ts:264`), so the read path trusts the file for a field that this pass's own reasoning says it
cannot trust.

Probe (red, `test/limits.test.ts`): hand-write a history record with a 3001-character `channel` — the
shape a session running the pre-F3-02 build leaves behind — and re-render the section. It grows by 3000
characters, quoted whole, and the notification quotes the whole name too. Same test, second probe,
reachable **today** with no foreign file at all: `run(channel="h-inject\n- and a line the model wrote")`
is legal (only names over 200 characters are refused), the record keeps the newline, and the section —
whose notes are one per line — gains a line of the model's own choosing:

```
  h-inject
- and a line the model wrote: last cell completed in 0ms — INJECTED_MARKER = 1 (defined: INJECTED_MARKER)
```

Expected fix: `oneLine(note.channel, …)` at the quote, in `lostChannelsLines` and in the notification,
the same shape F3-04 pinned for definitions. `code` is clipped at the write and has been all along, but it
is quoted raw too, and the same argument covers it — clip it on the read path as well. The bound to clip
to is a legibility choice; 200 matches what `run` accepts today.

### R4-02 — PAPERCUT — the stem fallback can report a live channel as lost, under a name it never had

`lastHistoryByChannel` (`manager.ts:846`) keys a record by `parsed.channel`, falling back to the **file
stem** when the record has no usable one, and `lostChannelNotes` (`manager.ts:876`) then asks
`this.channels.get(channel)` — the live map, keyed by real names. A stem is not a name (that is the whole
reason R2-04 moved the key to the record), so the liveness check misses.

Probe (red, `test/names.test.ts`): channel `r4-stem/live` is running; its own history file's newest record
has no `channel` field (hand-edited, truncated, or written by something that is not this program — the
same standard F3-04 applies to history files). The section says

```
  r4-stem_live-e906a10b94: last cell completed in 1.0s — r4_stem_marker = 1
```

about a channel that is running and still holds `still_here`. It is doubly wrong: the name it invents is a
digested stem, and since R3-03 that string names a *third* channel if the model types it back into
`channel`. (The reverse also holds: if some live channel *is* named `<stem>`, the note for the real
channel is suppressed instead.)

Expected fix: do not treat a stem as a name. Either ignore records with no usable `channel`, or resolve
the stem against the live set before using it — `channelFileStem(name)` for each live channel — and key
and display the real name it resolves to. The tie-break R3-08 added (`manager.ts:857`) is fine and stays.

### R4-03 — BUG — a channel that never becomes ready says nothing about itself, and R3-07's fix is not on that path

R3-07's pointer is produced inside `reportStartFailure` (`channel.ts:491`), which is reached only from
`onExit`, and even there it writes a file **only when the explanation was cut** (`channel.ts:503`). A
daemon that is alive and never reports `ready` is answered by the ready timeout instead
(`channel.ts:828`): the call is refused while the complaint is sitting in `loose`, and the daemon is
killed afterwards. Observed at HEAD with a stub that writes `ImportError: …` to the capture stream and
then wedges:

```
channel "wedge-why" could not start: the channel daemon did not report ready within 1.5s
```

— and with a 5 000-character complaint, the daemon's log path appears **about half a second after that
answer**, holding the reason, named by nobody. So the one start failure the model can least act on is the
one that carries no diagnosis at all, and the memory of why is written to a file no one is pointed at.

Expected fix: the ready-timeout path should go through the same reporting as the exit path — await
`channel.close(...)` (it is already started), then build the error from `deathNote + fatalNote +
startupOutput()` with the same 3 000-character cut and the same `writeFailedStartOutput()` pointer.
Holding test (`test/lifecycle.test.ts`) is deliberately permissive about the shape: the reason, or a file
that holds it, in the answer.

### R4-04 — PAPERCUT — `bg_stop` for a task that settled before its channel died says nothing about the channel

R3-05's fix lives in `stoppedResult` (`manager.ts:766`), which the *settled* branch of `bgStop`
(`manager.ts:727`) never reaches. A background cell that finished and then took the channel down (a
segfault in the epilogue, a daemon killed on the way out, an `os._exit` after the last print) answers

```
task repl-ln449hbc already finished (completed)
Log: /tmp/…/repl-ln449hbc.log
```

The status is right — the cell really did complete — but the model is given no reason not to reach for the
channel's variables, which is the exact harm R3-05 was about. Probe (red, `test/resilience.test.ts`):
background a cell, wait for it to finish, `kill -9` the daemon, then `bg_stop`. Expected fix: the same
death sentence `stoppedResult` appends, in this branch when `exec.deathNote ?? exec.channel.closed` says
the channel went. (`bg_stop` on a task whose channel died *without* an interrupt is the same branch;
there is nothing to contradict in that case, only a fact to add.)

### R4-05 — PAPERCUT — the capacity refusal blames the cap on an env var whose value it threw away

`intEnv` (`manager.ts:996`) falls back to 4 for a value it cannot use, which is reasonable; the problem is
the only place the cap is ever *reported*. `capacityRefusal` (`manager.ts:222`) says "the cap (4, set with
PI_REPLMODE_MAX_CHANNELS)". Probe (red, `test/cap.test.ts`) with `PI_REPLMODE_MAX_CHANNELS=0` and four
busy channels:

```
all 4 pi-replmode channels are busy and the cap (4, set with PI_REPLMODE_MAX_CHANNELS) is reached: …
```

A plausible way to turn the feature off reads like a setting that works, and the refusal attributes the
opposite number to it. Expected fix: distinguish unset from unusable in `intEnv` and say which cap is in
force and why ("the cap (4, the default — PI_REPLMODE_MAX_CHANNELS=0 is not usable)"), or honour 0 as
"no new channels" and make the refusal say that instead. Either way the sentence must not attribute a
number to a value that was ignored.

### R4-06 — BUG — an aborted `run` does not abandon the channel it was starting

`run` passes its `AbortSignal` to `channel.wait`, never to `getChannel` (`manager.ts:274`), so an abort
that lands while a channel is starting changes nothing. Two consequences, both probed red in
`test/lifecycle.test.ts`:

1. **the slot and the daemon stay.** With cap 1 and a wedged interpreter (a cold environment build, an
   import that hangs), aborting the call leaves the creation in `starting` — and the daemon alive — for
   the whole `PI_REPLMODE_READY_TIMEOUT_MS`. The next call is refused with R3-04's honest new sentence,
   "wait for the call that is starting to finish", about a call the model has already cancelled and
   `bg_wait` knows nothing about. The abort is the only thing the model *can* do to a wedged start, and
   it does not work.
2. **the cell runs anyway.** If the channel does come up after the abort (a slow start), `runLocked`
   walks in, sends the cell, and only then notices the signal: the frames the daemon received start with
   `{"t":"execute","id":"repl-…","code":"open('/tmp/should-not-exist-r406','w')…"}`. The user pressed
   Esc, the tool result says aborted, and the side effect happened.

This is the answer to the fixer's question in "R3-04 — deliberately weak" ("if pass 4 thinks that is a
finding rather than a limit, the fix is a tool-surface decision"). It is a finding, and it does **not**
need a new tool surface: thread the signal into `getChannel`/`createChannel`/`startChannel`, and on abort
close the half-started channel (which `startChannel`'s catch already knows how to do) and return the
"aborted" result without sending the cell. A name-taking close, or `bg_stop` by channel, is still worth
arguing for a wedged start that nobody aborted — but it is no longer the only way out.

### R4-07 — PAPERCUT — the channel-name rule exists only in the error that enforces it, and its wording forbids what the code accepts

F3-02 added a refusal, and the model choosing a name reads three places: the `channel` parameter
description (`index.ts:34`, "Isolated REPL instance (default "main"), created on first use. Separate
variables and process per channel." — nothing about names at all), the section, and the guidelines. None
mentions it, so a model that names a channel after a long path spends a call discovering it. And the
refusal says "Keep it under 200" while the check is `> 200`: a name of exactly 200 is accepted (pinned,
and the pin is what makes the wording wrong). Probes: red in `test/prompt.test.ts`, both about the
surface rather than the behaviour — the behaviour is right.

Expected fix: one clause in the `channel` parameter description (length is the rule; the digesting of
unsafe names is already documented and needs no room there), and "200 characters at most" in the refusal.
The limit itself is fine: a 200-character name is already absurd for a channel, and unlike a clipped
field, a name cannot be shortened without lying about which channel it names.

### R4-08 — PAPERCUT — the README says the 50 000 limit covers the whole answer, and the notes it just bounded ride over it

`README.md:80`: "The limit covers the whole answer, the traceback included." The tool's own text is careful
("Output over 50000 characters is truncated…"); the README is not. The suite has always allowed an answer
to exceed the limit by the banner and the notes — that is what `MAX_OUTPUT_CHARS + 5_000` encodes in every
`limits.test.ts` assertion — and the pass-3 bounding left the notes at ~3 KB (the definitions note alone
can be 1 500, the truncation notes and the log pointer another kilobyte). Measured at HEAD, with the real
tool: a cell that prints 36 KB, defines 30 names long enough to fill the note, and raises with a 13 KB
message answers **51 030 characters with nothing truncated** — capture and traceback together are under the
limit, and the notes are what push it over. (The bigger case in `limits.test.ts` — a 9 MB windowed capture
and a 300 KB traceback — answers 46 949, because both cuts and their markers fit inside the limit; the
promise is broken at the *middle* of the range, not at the extreme.) Either reserve room for the notes and
make the promise true, or say what the limit covers: "the capture and the traceback; the notes explaining a
cut add a couple of kilobytes". The holding test (`test/prompt.test.ts`) only forbids the false claim, so
either fix passes it.

### R4-09 — PAPERCUT — killing a channel erases its cells from everything the model can ask about

`shutdownChannel` (`manager.ts:240`) deletes the channel's tasks from the registry, and
`bg_stop {kill: true}`'s own answer (`manager.ts:712`) is the only thing the model gets about what it
just destroyed — it names **no log path**, unlike the plain stop two branches below it, which appends
`Log: …`. So after a kill: the listing no longer mentions the task, the kill answer has no log path, and
the next `bg_stop` on the id the model is holding says

```
unknown task: repl-2vcwo138. The ID comes from a run that moved to the background; tasks are tracked per
pi process and pruned after 3 days.
```

which is a lie about the cause: the id was dropped seconds ago, by the kill the model itself asked for.
Probes: two red tests in `test/resilience.test.ts`. The first is a disjunction on purpose — the cell must
still be findable afterwards, by the kill answer naming its log or by the listing still carrying it — so
the fixer can choose which side to fix. The second only forbids blaming the retention window and requires
the answer to say what did happen.

### Re-checking pass 3's fixes, at the fix

| fix | what pass 4 tried | result |
| --- | --- | --- |
| **R3-01** note ring, definitions note, history file, section hint, `ename`, channel-name cap | whole model-facing surface rather than one field: 8 lost channels × 6 remembered names and 300 records on disk (largest legitimate section measured: 1 785 stable + 8 × ≤1 012 = 8 601 bytes); the `session_start` notification; the banner (`ready.cwd` is written before any cell runs, so a cell's `os.chdir` cannot move it, and `ready.python`/`ipython` are only cell-forgeable by a cell writing raw frames to the protocol fd, which is already the same vector as a forged `log` frame); `info.code` (`oneLine(_, 100)`); `details.definitions` raw (accepted) | **held** for every field a cell can size in a *result*. **Broken** at the one field bounded only on the write side: the record's `channel` name on the read path (R4-01). Two things noted and not filed: `Channel.fatalNote` is kept unclipped in memory (bounded at 3 000 where it is quoted), and the note ring's 500 × 6 is a legibility budget, not a derived one |
| **R3-02** one argv token | names `--`, `--channel=x`, `=`, `-x=y`, `a--b`, `--help`, `-`, `-r3-dash` end to end, and `pi.channel` compared to the name the model asked for (new passing test); unicode, emoji, RTL mark, tab, newline, lone surrogate, 200/201 characters; a name containing `=` inside one token | **held** for all of it. A NUL byte never reaches the daemon: node refuses the argument ("must be a string without null bytes") and the answer is that message, bounded and honest — ugly, not wrong, so not filed |
| **R3-03** a digested-looking name is never verbatim | the regex boundary (`x-0000000000` digested, `x-00000000000` kept, `x-ABCDEF0123` kept), the 40/41-character threshold, `channelFileStem` applied three deep to fifteen names including empty and NUL, and whether anything feeds a stem back (grep: `channelFileStem` is called from `channel.ts` × 3 and `manager.ts` × 1, all on a real name; `lastHistoryByChannel`'s `stem` variable is the only stem-as-name, and that is R4-02) | **held**, and the argument is now pinned by a property test: every stem the digest branch emits matches `LOOKS_DIGESTED`, so a fixed point is unreachable by construction rather than by luck. `x-00000000000` staying verbatim is *correct* — the function can never emit eleven hex digits, and only emitted forms can collide. Collisions in principle: 40 bits, so ~1.3 M distinct names before a 50 % birthday chance; a session that creates four channels at a time will not get there |
| **R3-04** the refusal says which slots the starters hold | cap 1 with one wedged starter (the new wording, red-checked by the existing test); one live-busy + one starting at cap 2 (mixed sentence, see below); a creation that fails while holding the slot (still pinned); `PI_REPLMODE_MAX_CHANNELS=0` and garbage; five parallel calls on **one** new name; an aborted creation | wording **held** where it matters; `0`/garbage fall back to 4 and the sentence then blames the env var (R4-05); five calls on one name start exactly one daemon (new passing test, pins the dedupe half of R2-03); and the "wait for the call that is starting" advice can name a call the model already aborted (R4-06) |
| **R3-05** `bgStop` reads the death note | `kill: true` on a channel that was already gone (fine: "…its variables are gone. (the channel was already gone)" — one sentence, no contradiction; now pinned by a passing test); a task whose channel died *after* it settled (R4-04); a task removed by its own kill (R4-09) | **held** for the branch it fixed |
| **R3-06** the section and guidelines carry the process-group exception | read all six places: `channel.ts` header, `DESIGN.md:161` ("stated wherever the promise is made"), README, the `kill` parameter text, the section, the guideline | **held**, all six agree. Section is 1 785 bytes stable, as the fixer said |
| **R3-07** write the complaint, point at it, trim inside the oldest chunk | two failed starts on one name (it **appends**: the second answer's file holds both complaints, and both answers name the same path — now a passing test, with a mutation for the truncating variant); >64 KB and the disclosed drop count (existing tests, and they agree — `CaptureSplitter`'s held-back trailing bytes are not counted in `looseDropped`, at most 6 of them); a complaint to the protocol fd instead (goes through `note`, clipped to 500 by R3-01); the ready-timeout path | **held** for the exit path. **Never reached** for the never-ready path (R4-03). A write that fails (read-only agent dir) was not attempted — it already answers "the rest of the daemon's output was dropped and could not be saved", which is the honest branch |
| **R3-08** newest record wins | three files for one channel, a torn tail, a non-string `ts`, equal `ts`, and a record whose channel is live | the tie-break **held** (including equal `ts`, where the record read later wins, as documented). The live-channel case fails through the *other* door in the same function: the stem fallback (R4-02). A rolled-back clock still reorders records — argued and left: `ts` is what this code writes, and any fix that trusts mtime instead re-breaks the upgrade case |
| **R3-09** count after the append | the line unit (new test: "N of M lines" counts the file including the host's own `[full traceback for this cell]` header); the race between the count and the answer (not reachable — the count and the result text are built in one synchronous block); the log vanishing (the `Math.max` floor covers it); the 16 MB scan cap (existing) | **held**; the new line-unit pin killed a mutation the char-unit pin did not |
| **R3-10** the startup header, and the claim behind it | the case the fixer named: cell 1 answers, cell 2 dies before its opening marker. The bytes between the cells went to **cell 1's** log under "after this cell ended" (true — cell 1 did end), cell 2's log holds nothing, and no startup header appears anywhere; a mutation that parks those bytes in `loose` instead dies on this test. The claim "`loose` only ever holds pre-first-boundary bytes" holds by construction: `writeToSink`'s `lastClosed` branch (`channel.ts:409`) is taken for every chunk after the first block closes | **held** |

### Probed and left alone

- The mixed capacity sentence: with cap 4, one live-busy channel and three starters it says "all 4
  pi-replmode channels are busy", where "all 4" is the cap rather than the number running, and then
  corrects itself ("…`"x"` is also still starting"). Slightly loose, self-correcting, and a reword would
  make the common case (everything busy) longer to read. Left.
- `deadResult` does not carry the out-of-band-output disclosure that `finishedResult` adds. Deliberate, I
  think: on a dead channel the note would send the model hunting for a process the group kill just took
  down. Not filed; worth a sentence in `channel.ts` if a future pass disagrees.
- `bg_wait` calls `countOutput` (bounded at 16 MB per file) for **every** tracked task, up to
  `TASK_REGISTRY_LIMIT = 200` — a session that backgrounds two hundred chatty cells pays gigabytes of
  reading per `bg_wait`. Cost, not correctness, and the fix is obvious (`statSync` already gives `bytes`;
  count lines and characters for the ≤30 tasks the listing shows). Filed as a note for the fixer rather
  than a holding test, since the only honest test for it is a timing one.
- `structuredContent.tasks` mirrors all 200 rows while the text listing caps at 30 — the same asymmetry as
  `details.definitions`, already accepted.
- A channel name with a NUL byte, a lone surrogate, an RTL mark or a zero-width joiner all reach the
  daemon intact and name their own files; nothing sanitises them further, and nothing needs to.
- Accepted limits re-checked and still accepted, not re-opened: per-exec capture pipes and the
  unattributable window, the sticky out-of-band note, `structuredContent.output` excluding the traceback,
  the 64 MB `MAX_FRAME_BYTES` `_overlong` hole, `status: "dead"` for argument errors, and mutations M6 and
  M11.

### Mutation re-run

`scripts/mutation-audit.sh` grew four lines (36 total): the three new pins this pass added
(R3-03's uppercase digest, R3-10's late-bytes routing, R3-07's append-not-truncate) and R3-09's line
totals. Full pass on the committed tree: **see the table in the next commit's note** — it was run after
this section was written, so the result is recorded in `MEMORY.md` and in the commit that follows.

### Handoff to the fixer (pass 4)

Order that keeps the tree comprehensible:

1. **R4-06 first** — it is the only finding that changes behaviour under a user pressing Esc, and the only
   BUG with a side effect. Thread the abort into `getChannel`/`startChannel`; make the aborted call return
   a result that says it was aborted and never sent its cell. If `startChannel` grows a signal-aware race,
   keep `startChannel`'s existing "nothing is half-started" catch — that is what makes this safe.
2. **R4-03** in the same file: the ready-timeout path deserves `reportStartFailure`'s treatment. Do not
   make the answer wait longer than the ready timeout itself.
3. **R4-02** then **R4-01**, both on the history-read path: fix the key (stem ≠ name) before adding the
   clip, because R4-01's fix is a quoting change and R4-02's decides *which* channels get quoted at all.
4. **R4-04** and **R4-09** in `bgStop` — three branches of one function, one sentence each.
5. **R4-05**, **R4-07**, **R4-08**: prose and one clause of parameter description each.

What each fix must not break:

- R4-06: the invariant that a timeout never kills a cell (an abort already interrupts — sending nothing at
  all is consistent with that, killing something is not); the R1-11 test that a wedged interpreter and its
  children are taken down; the R2-03 test that a creation occupies a slot and a failed one gives it back;
  and the R3-04 wording tests, whose "wait for the call that is starting" sentence may need to change once
  waiting is no longer the only move — if it does, update it in the same commit and say so.
- R4-02: the old-naming upgrade tests in `names.test.ts` and `prompt.test.ts` pin that a record with a real
  `channel` field is still read from a pre-digest file name. A fix that ignores records without a
  `channel` field must keep reporting the ones with it.
- R4-01: the section must keep saying which channels are gone and what their last cell ran
  (`prompt.test.ts`), and must stay byte-stable inside a session.
- R4-04/R4-09: `background.test.ts`'s contract that a successful result has no `isError` key; the R3-05
  tests; `statusOf` semantics (the cell of a settled task really did complete — the *channel* is the thing
  that went).
- R4-05: `intEnv` is shared with `PI_REPLMODE_READY_TIMEOUT_MS` (via `readyTimeout`, which has its own
  cap) — do not change one cap's fallback semantics and leave the other's silently different.

Then: `npm run check`, re-run `bash scripts/mutation-audit.sh` (add a line per fix; the four anchors this
pass added are in the "pass 4's re-pins" block), and the real-`pi` smoke: the DEV.md prompt, one dash-named
channel, `os._exit(3)`, and the `bg_stop` death sentence — plus, new this pass, one call aborted while its
channel is starting, checked afterwards with `ps` for a daemon that should not exist.
