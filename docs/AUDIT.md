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
