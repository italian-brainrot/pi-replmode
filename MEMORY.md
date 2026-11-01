# MEMORY.md

pi-replmode: a pi extension that replaces pi's one-shot tools with one stateful IPython REPL.
Registers `run`, `bg_wait`, `bg_stop` only — it never touches the active tool set.

- Design, decisions, milestones: [docs/DESIGN.md](docs/DESIGN.md). Commands, debugging, gotchas:
  [docs/DEV.md](docs/DEV.md). README is for users; AGENTS.md is the user's, do not reformat it.
- One Python process per channel (`python/`), JSON frames on a saved fd 1, all code output captured at
  fd level on stderr with `PIRB` sentinels. TypeScript side in `src/`.
- Status: M1 (core) and M2 (channels, timeouts→background, bg_wait/bg_stop, reload re-adoption) are
  done and covered by real-process tests (pytest + vitest). M3 = display/images, `pi.read_image`,
  `pi.ask`, `pi.run_subagent` over a `call`/`call_reply` pump — not started.
- Audit loop state: **passes 1–4 are complete — a tester and a fixer each. Pass 4's nine findings
  (R4-01…R4-09) are fixed, and the suite is green: 192 vitest, 47 pytest, `tsc`, `biome`.** Next is
  **pass 5 (tester): attack the pass-4 fixes.** Read [docs/AUDIT.md](docs/AUDIT.md) §"Pass 4 fixes —
  2026-11-01 (fixer)": every write-up says where that fix is deliberately weak, and §"Handoff to pass 5
  (tester)" lists eight targets in order, three of them places the fixer chose the cheap side on purpose.
  Pass 4 also produced two fixer-found defects, each with its own tests: **F4-01** (a `quit()` could not
  see a channel that was still starting) and **F4-02** (a call arriving in the window after a daemon died
  was handed the dead channel — it was a suite flake before it was understood as a bug). One tester-written
  test line was *changed*, never loosened, argued under §"One test changed (pass 4 fixes)". Never weaken a
  test; *adding* an assertion is how an unpinned fix gets pinned.
- What pass 4's fixes established, one line each (write-ups in AUDIT): a model-facing field is bounded
  **where it is read**, not only where it is written — a history file may predate any bound, and no field of
  a hand-written record may reshape the prompt section (`historyChannelLabel` refuses to print a name it
  cannot print); a file stem is never a channel key; a daemon that never reports `ready` is stopped and
  answered through the same `startFailureError()` as one that died; `bg_stop`'s three branches (stopped,
  settled, unknown id) each have their own wording and each is pinned; a task removed because its channel
  went is remembered in `droppedTasks`, so a later `bg_stop` cannot blame the retention window; the capacity
  refusal names the source of the cap it used; a rule that makes a call fail belongs on the surface where
  the value is chosen (the `channel` parameter description); and the 50 000 limit covers the cell's own text
  (capture + traceback together), never the notes around the cut.
- Startup, abort and shutdown invariants (pass 4, all pinned by tests): a tool call's `AbortSignal` is
  threaded *into* channel creation — `startChannel` races `ready` / the ready timeout / the abort,
  `createChannel` stops at `untilAborted(ensureEnv(…))` — the `starting` slot is released the moment the
  signal fires (guard by promise identity, detach the listener when the wait ends), and `run` never sends a
  cell on a cancelled call, including one that was queued behind another call on the channel. Do not cancel
  a start by racing `getChannel` from outside: a creation still running in the background would install its
  daemon afterwards. `Channel.close` is **one-shot** per channel. `quit()` closes `halfStarted` (fed by the
  `onSpawned` hook) and refuses to adopt a daemon that finished after the quit it raced — a **quit epoch**,
  deliberately not a boolean, because the manager outlives sessions. `getChannel` asks `processGone(pid)`
  (a zombie reads as gone) before handing out a channel, because `channel.closed` lags a death by an event
  loop turn.
- Real-`pi` smoke: the DEV.md prompt, a dash-named channel, `os._exit(3)`, and a `bg_stop {kill: true}`
  (its answer ends with `Log: <path>`). To smoke an abort use `bash scripts/smoke-abort-start.sh` —
  throwaway `PI_CODING_AGENT_DIR`, `PI_REPLMODE_ENV_DIR` at a stub whose `bin/python` sleeps, `script -qec`
  for a pty, and the byte for Esc. **`pi -p` cannot smoke an abort**: SIGINT there is a hard kill (exit 130)
  that runs no `session_shutdown` and fires no abort — measured with an idle daemon that survived it.
- What pass 4 held under attack, so it is not re-derived: R3-02's one-token argv (every hostile name shape
  end to end, NUL refused by node before argparse), R3-03's injectivity (now a property test: a stem the
  digest branch emits always looks digested, so a fixed point is unreachable; `x-00000000000` staying
  verbatim is *correct*), R3-04's wording except `0`/garbage, R3-05's branch, R3-06's six places, R3-07's
  append-across-two-failed-starts and in-chunk trimming on the **exit** path, R3-08's newest-`ts` tie-break,
  R3-09 in both units (a new *line*-totals pin), R3-10's attribution (a new cell-1/cell-2 pin). Left alone
  on purpose: `fatalNote` unclipped in memory (clipped where quoted), the mixed "all N are busy" capacity
  wording, `bg_wait` calling `countOutput` for up to 200 tasks (cost, not correctness), `deadResult` not
  repeating the out-of-band disclosure, and everything in AUDIT's accepted list.
- What pass 3 and its fixes established, so a future session does not re-derive it: the 50 000 promise now
  has to hold for *every copy* of a cell-chosen string, not just the capture and the traceback — the daemon
  note ring (each entry clipped to 500 characters at store time in `Channel.note`), the "defined by this
  cell" note (25 names × 60), the history file (20 × 120), the prompt section's `definitionHint` (6 × 60,
  bounded independently of the write because a history file may predate the bound), `ename` (200, also in
  the task listing), and the channel name itself (`run` refuses > 200: it lands in results, in the history
  file and in every later prompt). `details.definitions` stays raw on purpose.
- Where the design is deliberately weak (know this before filing it as a bug; argue in AUDIT.md to change
  it): capture bytes that arrive **during** another cell's block are unattributable — the host flags a
  channel that has produced out-of-band bytes and says so in later results; per-exec capture pipes were
  rejected for deadlock (AUDIT "R2-07 decided"); the out-of-band note is sticky per channel; a start-failure
  report waits only `STDIO_DRAIN_MS` (200 ms) for the dead daemon's stderr, and bytes past the 64 KB startup
  buffer are gone (now exactly the oldest ones, counted in the answer and in the file);
  `structuredContent.output` is the capture without the traceback; the banner and notes ride a couple of KB
  above 50 000 (the suite's `+5_000` slack encodes that); the clipping numbers (60/120/200/500) are
  legibility choices, not derived; and **only the call that is starting a channel can free it** — `bg_stop`
  has no task id to take, so a wedged creation holds a slot until its own caller is cancelled (that is what
  R4-06 made possible) or the ready timeout fires, which the capacity refusal says out loud. Added by pass
  4's fixes, and weak on purpose: `bg_wait`'s listing still forgets a task whose channel was killed (the
  kill answer names the log instead, and `droppedTasks` remembers up to 200 such ids); the `onSpawned`
  branch that closes a daemon spawned after a quit began walking is unpinned; `processGone` trusts the pid
  the host spawned and is Linux-specific in its zombie check; the 200-character name rule is in the tool
  schema, not in the prompt section; and the capacity refusal's "all N are busy" wording is still mixed when
  some names are starting. Pass 3's suggested cheap signal
  for the unattributable case — read `/proc/<daemon>/task/*/children` at exec end and say "this cell left
  processes running" — is still argued, not implemented.
- Pass 2 attacked pass 1's fixes; pass 3 attacked pass 2's; pass 4 attacked the pass-3 fixes, and eight of
  its nine findings landed there. Held under attack and re-pinned: the interrupt design (both paths), the
  group kill and its process-group exception, the cap arithmetic (a cap of 1, and failed starts releasing a
  slot), the out-of-band note, the traceback budget, windowed truncation coordinates, the name encoder's
  shape (property test), the history-file upgrade path, R3-02's argv, R3-06's prose, R3-09's two units, and
  R3-10's attribution. Did not hold, found and fixed in pass 4: quoting a field only at its write (R4-01),
  a file stem used as a channel key (R4-02), a start path that never reaches its own reporting (R4-03), a
  fixed branch of a three-branch function (R4-04, R4-09), an env value reported after being ignored (R4-05),
  an abort that is not threaded through the thing it cancels (R4-06), a rule that exists only in the error
  that enforces it (R4-07), and a README claim the suite's `+5_000` slack had been hiding (R4-08).
- Mutation testing is a tool now: `scripts/mutation-audit.sh`, ~70 lines, takes a label substring
  (`bash scripts/mutation-audit.sh R3-0`); the full list is 55 mutations and **~20 minutes**, and **requires
  a committed tree** (it reverts with `git checkout`). Its verdict is the *set of failing test names*
  compared with a per-file baseline taken on a clean tree — an exit code says nothing while tests are red on
  purpose — and it refuses to apply an anchor that does not typecheck. Anchors rot: pass 4 found three that
  had stopped matching the code's shape (M4, `keepNewest`, R3-10) and had been silently skipped; re-find the
  anchor, never delete the line. Pass 4's final run: **53 of 55 die, and the two survivors are the accepted
  ones** — `flushLoose`'s `Exec.lateWrite` → `Exec.write` (both append in the only reachable case; the
  *header* is a separate mutation that does die) and `failure()`'s choice of status (the enum has no
  "rejected" value). Three traps this pass learned the hard way: a multi-line anchor must be **one**
  single-quoted bash argument, so `bash -n scripts/mutation-audit.sh` and an anchor-checking dry run (a copy
  of the script whose `run_mutation` only verifies the anchor) are worth running before the 20 minutes;
  a mutation whose *testspec* names the wrong test file reads as a survival (the R4-06 guard inside the
  channel lock lives in `runLocked`, not in the start path — its line had to move to `run.test.ts`); and a
  test that awaits a call before checking whether a process is alive can be satisfied by a product timeout
  doing the killing, which is how F4-01's first test escaped its own mutation.
- Things that are easy to get wrong and are now pinned by tests: an interrupt must reach a cell parked on
  an `await` (there is no `asyncio.Task.throw`; the interrupt goes onto the future the cell task waits
  for, with cancel as the escalation); the SIGINT *disposition* is restored at every exec boundary; the
  daemon writes sentinels to its own `dup` of the capture pipe and repairs fd 1/2 per cell; closing a
  channel always group-kills; late capture bytes are attributed to the exec that produced them, and bytes
  from before the first block ever opened get the *startup* header, never the "after this cell ended" one
  (R3-10); the startup buffer is trimmed inside its oldest chunk by `keepNewest`, never dropped whole, and
  for a channel that never reported `ready` the host writes what it received into the daemon's log path —
  that is what the start-failure pointer names, and it happens only while `ready` is undefined, so a running
  channel's own log is never stolen (R3-07); the cap counts daemons that are still starting (`starting` ∪
  live) and a failed start releases its slot, and the refusal says "are busy" only when something really is
  running — otherwise it names the channels that are still starting (R3-04); `bg_stop` appends the channel's
  death note, with the word "variables", when the interrupt is what took the channel down (R3-05); every
  file name and path a channel name becomes comes from `names.ts` and `Channel`'s paths (the daemon's
  `--log` argument included), the name reaches argparse as one token `--channel=<name>` (R3-02), and
  `channelFileStem` is **not idempotent** — a name that looks digested (`-[0-9a-f]{10}$`) never stays
  verbatim, which is what makes it injective (R3-03) — so never feed a stem back into it; when two history
  files remember one channel the newest `ts` wins, not `readdirSync` order (R3-08); the 50 000 limit covers
  the traceback as well as the capture, and the truncation note's totals are counted from the log *after*
  the traceback is appended to it (R3-09); truncation offsets are log coordinates, and a windowed log's tail
  survives an oversized final line; a successful `run` result has no `isError` key at all; a cancelled call's
  answer carries `aborted: true` with `status: "dead"` and says nothing was sent; `Channel.close` is
  one-shot, `quit()` closes the `halfStarted` daemons and the quit epoch refuses to adopt a start that raced
  it, and `getChannel` asks `processGone` before reusing a channel (F4-01, F4-02).
- Three rules that must not change: a timeout never kills a cell, the daemon never uses
  `asyncio.run()`, and a test is never weakened to make a fix pass — argue it in AUDIT.md instead. Never
  delete an assertion from a passing test either: pass 2 nearly lost one to an editing slip in
  `test/lifecycle.test.ts` and caught it with `git diff | grep '^-'`. Three test lines have been *changed*
  (never loosened), each argued in AUDIT.md: pass 2's `expect(shown, …)` handed a string to `toBeLessThan`
  (which throws in vitest, so that R2-02 assertion had never run — it is `expect(shown.length, …)` now, same
  bound), pass 3's fixes changed R3-02's `expect(result.isError)` from `.toBe(false)` to `.toBeUndefined()`
  because the contract pinned green by `background.test.ts` is that a successful result carries no `isError`
  at all, and pass 4 widened one import in `test/prompt.test.ts` (`repoRoot`, `text as text2`) so a new test
  could read the README — no assertion in that file was touched.
- Tests drive real processes only; where a daemon must misbehave (never ready, dies after answering,
  closes its protocol fd, dies on SIGINT, writes its complaint to the capture stream, emits a `fatal`
  frame) `test/lifecycle.test.ts` swaps in a **stub interpreter** via `PI_REPLMODE_ENV_DIR` — a dir with
  `.complete` plus an executable `bin/python`. Beware: the stub's script lives in a template literal, so
  any tool that re-indents the test file's lines breaks the stub with an `IndentationError`.
  `PI_REPLMODE_READY_TIMEOUT_MS` and `PI_REPLMODE_REQUIREMENTS` exist so those paths are reachable at all.
  `npx pytest` does not work (no such package) — use `npm run py:test -- [pytest args]`, and `npm run fmt`
  before expecting biome to pass. One manager and one agent dir per vitest **file**; inside a file,
  `vi.resetModules()` + a second `loadExtension({agentDir})` is how you simulate a reload — without the
  reset the module (whose paths are fixed at import) is reused and your temp dir is not where anything
  goes. Timing-sensitive suites: re-run any flake twice and report it.
