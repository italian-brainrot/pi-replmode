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
- Audit loop state: **pass 6 (tester) is complete — three findings filed (R6-01, R6-02, R6-03), each with
  a holding test that stays red. Next is pass 6 (fixer).** Read [docs/AUDIT.md](docs/AUDIT.md)
  §"Pass 6 audit — 2026-11-01 (tester)": per-finding write-ups (mechanism, measured reproduction, what the
  fix must not break), §"Re-checking pass 5's fixes — what held", §"Probed, measured, and not filed", and
  §"Handoff to the fixer (pass 6)" for the order of preference. Gate this pass leaves: tsc/biome green,
  **207 vitest — 204 pass, 3 fail on purpose** (two identical full runs, only timings differed), **47
  pytest**, `ANCHORS_ONLY=1 bash scripts/mutation-audit.sh` → all **66 anchors match**. The **full 66-mutation
  run was not repeated by pass 6** (no product code changed; the anchor check is the part that rots) — the
  fixer owes it after the fixes, and owes R6-01's fix a mutation of its own (the join's two mutations are
  both about the answer, neither about epochs).
  New test ids: `R6-01: a call made after a session ended is not part of that session` and `R6-02: an
  aborted joiner does not report the channel it was waiting for as dead` (both `lifecycle.test.ts`, both in
  the new describe "a call that joins a channel creation which cannot succeed"), and `R6-03: and the
  answer's channel field names the channel its own sentence names` (`resilience.test.ts`, in "killing a
  channel"). Pass 6 changed no test assertion and no product file; it added three tests.
- What pass 6's findings and measurement establish, one line each: **a join is not an owner, and it is not
  an epoch either** — `getChannel` joins whatever is in `starting` regardless of which session started it,
  so with `PI_REPLMODE_KEEP_RUNNING=0` (which makes every `/new` and `/resume` run `quit()`) a call in a
  live session waits 535 ms for a doomed creation and is answered with the dead session's sentence,
  `the session ended while this channel was starting`, and its aborted sibling is told the other call
  "carries on" with a creation that failed moments later (R6-01, red; the fix must not clear `starting`
  from `quit()`, and the "start our own" route re-opens the measured 4.5 s two-daemons-one-name window);
  **reusing an answer shape reuses its claims** — a cancelled *joiner* is answered by R4-06's
  `abortedResult`, so it reports `status: "dead"` in both structured views about a channel that completed
  and was met again by pid a second later, contradicting its own sentence (R6-02, red); **an answer built
  by `throw` inherits the tool's channel, not the answer's** — `failure(error, "main")` gives `bg_stop`'s
  dropped-task answer `details.channel`/`structuredContent.channel` = `"main"` while its text names the
  killed channel, and the generic "unknown task" branch invents `"main"` for an id that never existed
  (R6-03, red).
- What pass 6 held under attack, so it is not re-derived: **R5-03's renderer really is total, and so is
  the handler around it** (`ensureDirs` swallows per-directory errors, so `pruneRetention` cannot throw;
  `lastHistoryByChannel`'s per-file body is in a `try`, `ts` is coerced, `channel` is shape-checked before
  it becomes a key; hostile records — `definitions` a string / an array of objects / 100 000 entries →
  `+99994 more`, nested arrays, `torn: "lots"`, numeric `ts`, a 5 MB `code` — each cost one line; there is
  no `await` between the two `section =` assignments; and a record filed under a **live** channel's name
  never reaches the section, because `lostChannelNotes` drops live channels first); pass 5's late-spawn pin
  is **not flaky** (4/4 loaded runs of `lifecycle.test.ts`, 31/31 each) and leaves no env build in flight;
  `signalDiagnosis`'s `Z` entry is unreachable dead prose (the exit path settles the exec first), and a
  cell's child in `T` never reaches the busy branch at all (PEP 475 re-raises after the handler, so the
  cell dies on SIGINT); `Channel.begin` opens the exec log eagerly, so R5-04's past tense can never be
  about a file that did not exist; and R5-07's process-wide count is worded "tracked", which stays true
  after a `/new` — the ids are not in the answer, so no model can take the wrong action from it.
  Probed, measured, **not filed** (details and the reproduction in AUDIT): a call that has its channel and
  is queued behind another cell when the channel goes is answered with the bare death note —
  `the Python process behind channel "x" ended (exit code unknown, signal SIGTERM)` — and never says its
  cell was never sent, though `Channel.begin` threw before `send`; reachability needs a quit the session
  survives (`KEEP_RUNNING=0`), because the cap's retirement cannot hit a queued call. `runLocked` wants a
  `channel.closed` guard next to its `signal?.aborted` one.
- What pass 5's findings and fixes establish, one line each: **a joiner on somebody else's channel
  creation must be given its own abort handling** — `getChannel`'s join is
  `untilAborted(pending, signal, name, true)`, and a `ChannelJoinAbortedError` keeps the joiner's answer
  from claiming it freed a slot it never held; the joiner must never cancel the creator's creation, close
  its daemon, or release its slot (R5-01, fixed; measured before: an aborted joiner answered 8 869 ms
  later, at the *creator's* ready timeout); **a value captured after an await is not the value the call
  started with** — `createChannel` reads `quitEpoch` on entry, before `makeRoom`, or a quit during a slow
  retirement adopts the new daemon and answers a dead session with `status: "completed"` (R5-02, fixed);
  **a model-facing field of the wrong shape must be rejected where it is read** — a JSON string in a
  history record's `definitions` has a `length` and no `map`, so `definitionHint` now checks
  `Array.isArray`, and each remembered channel's line is built in a `try` so one unreadable record costs
  its own line (R5-03, fixed: the section is rendered by code that is *total* over untrusted records, and
  `session_start` assigns the stable part before reading any history file rather than swallowing throws);
  **a pointer an answer sends the model to needs `existsSync` at the answer**, since the retention sweep
  runs on every `session_start` of a long-lived process and at 200 logs (R5-04, fixed in `bgStop`'s
  dropped-task branch); **when the process table contradicts the diagnosis, say what the table says** —
  `processState` is now shared with `processGone` and `signalDiagnosis` names `T`/`t`/`D`/`Z` in the busy
  answer, without ever escalating on its own (R5-05, fixed); **a limit's stated reason must be one the
  code backs up** — `channelFileStem` digests every name over 40 characters or with an unsafe character,
  so stems are ≤ ~51 whatever the name and the 200-character rule is *not* a file-name rule; both
  sentences now say the name comes back to the model (R5-06, fixed — and pass 4's write-up was wrong about
  the digest/length interaction); **a listing sentence built from a different source than the summary
  above it can contradict it** — `taskSection(infos, droppedTasks.size)` never denies a task the same
  answer just reported, while R4-09's accepted "no rows for killed tasks" stands (R5-07, fixed).
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
  loop turn. Two aborted starts of one name under a cap of 1 each release their own slot and their own daemon
  (the identity guard, green-pinned in pass 5), and a channel that is `ready` is never timed out — so a daemon
  the manager loses track of stays alive forever, which is how R5-02 was measured.
- Real-`pi` smoke: the DEV.md prompt, a dash-named channel, `os._exit(3)`, and a `bg_stop {kill: true}`
  (its answer ends with `Log: <path>`). Pass 5's fixes added two checks that cost one run each: ask the
  model to quote the `channel` parameter description verbatim (that is how a wrong sentence in the schema
  is proven to be believed), and drop a hand-written `~/.pi/agent/replmode/history/<name>.jsonl` with
  `"definitions": "df"` and look for `Extension error` — at HEAD it printed twice and the section vanished.
  Note that **one history file yields one record** to the note (the newest usable), so each hostile record
  needs its own file. To smoke an abort use `bash scripts/smoke-abort-start.sh` —
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
  4's fixes, and weak on purpose: the `onSpawned` branch that closes a daemon spawned after a quit began
  walking **is now pinned** (pass 5's fixes; the deterministic route is in AUDIT); `processGone` trusts the
  pid the host spawned and is Linux-specific in its zombie check (so is `signalDiagnosis`, which shares its
  state read and is handed the *daemon's* pid — a cell's child sitting in `T` is not diagnosed); the
  200-character name rule is in the tool schema, not in the prompt section, and why the number is 200 is a
  prompt-cost judgement the tests do not pin; the capacity refusal's "all N are busy" wording is still mixed
  when some names are starting; and **a joiner's cancel does not free a wedged creation** — only the call
  that is starting it can, and R5-01's fix says exactly that in the answer instead of implying otherwise.
  Added by pass 5's fixes, and weak on purpose: `bg_wait`'s listing still gives no rows for tasks whose
  channel went (R4-09's half-measure stands — the empty-listing *sentence* now counts them and points at
  `bg_stop`), and that count comes from the process-wide `droppedTasks`, so after `/new` it can include the
  previous session's drops (the sentence says "tracked", not "this session", to stay true); the R5-04 answer
  still names a log it knows is gone, and says not-where rather than why; `session_start` does **not** catch
  throws — the renderer is total instead, and `section = renderSection([])` before the notes is insurance no
  test can reach, because nothing reachable can make it throw; the unreadable-record line names the channel
  but quotes no fields; and `signalDiagnosis` reads the state at answer time, so a process continued in the
  meantime gets the generic sentence. Pass 5 also probed and
  left alone: two daemons for one name can coexist for the length of a `close()` — measured at **4.5 s** for a
  daemon that ignores `shutdown` and SIGTERM — sharing one daemon log, history file and IPython profile, which
  two pi processes can already do to each other; `droppedTasks`' 200-id cap restores the old retention
  sentence for a session that churns more channels than that; `STRUCTURED_OUTPUT_MAX_BYTES` is exported and
  never used (`cut.text` is sliced at
  1 048 576 *characters* and can never approach it). (`lostChannelNotes()` being called twice per
  `session_start` was fixed by pass 5's R5-03 change.) Pass 3's suggested cheap signal
  for the unattributable case — read `/proc/<daemon>/task/*/children` at exec end and say "this cell left
  processes running" — is still argued, not implemented.
- Pass 2 attacked pass 1's fixes; pass 3 attacked pass 2's; pass 4 attacked the pass-3 fixes, and eight of
  its nine findings landed there; **pass 5 attacked the pass-4 fixes and landed seven (R5-01…R5-07), three of
  them inside pass-4 fixes** — a signal never threaded into a *join*, a value captured after an await (the quit
  epoch must be read before `makeRoom`), and a guard that trusted `length` on a field whose shape it did not
  check. Held under attack and re-pinned: the one-shot `close`; the promise-identity guard on the `starting`
  slot, now green-pinned for two aborted starts of one name under a cap of 1; `processGone`'s liveness read
  against a stopped process, a recycled pid and a reload-adopted channel (nothing found — R5-05 is the
  *diagnosis*, not the liveness read); `startFailureReported`; the `historyChannelLabel` refusal (the section
  stays useful with the name refused); R4-02's digest rule and its `torn` wording; and the `+5_000` slack,
  measured this time rather than spot-checked (worst legitimate answer 47 553 characters with a 481-character
  agent dir, ≈52–54 KB with the maximum note pile-up, so it breaks only past ~800-character agent-dir paths). Held under attack and re-pinned: the interrupt design (both paths), the
  group kill and its process-group exception, the cap arithmetic (a cap of 1, and failed starts releasing a
  slot), the out-of-band note, the traceback budget, windowed truncation coordinates, the name encoder's
  shape (property test), the history-file upgrade path, R3-02's argv, R3-06's prose, R3-09's two units, and
  R3-10's attribution. Did not hold, found and fixed in pass 4: quoting a field only at its write (R4-01),
  a file stem used as a channel key (R4-02), a start path that never reaches its own reporting (R4-03), a
  fixed branch of a three-branch function (R4-04, R4-09), an env value reported after being ignored (R4-05),
  an abort that is not threaded through the thing it cancels (R4-06), a rule that exists only in the error
  that enforces it (R4-07), and a README claim the suite's `+5_000` slack had been hiding (R4-08). **Pass 5's
  fixes landed all seven: R5-01, R5-02 and R5-03 changed behaviour, R5-04/05/06/07 changed answers.** Pass 6
  attacks those fixes; the attack list is the last section of AUDIT's pass-5 write-up, and the thin places are
  listed under "Added by pass 5's fixes, and weak on purpose" above.
- Mutation testing is a tool now: `scripts/mutation-audit.sh`, ~90 lines, takes a label substring
  (`bash scripts/mutation-audit.sh R3-0`); the full list is 66 mutations and **~50 minutes** (it is dominated
  by the lifecycle/resilience files, which are ~45 s each, and each mutation runs one baseline plus one
  mutated run of its file). It restores the mutated file
  from a copy taken before the break — **not** with `git checkout`, which threw away uncommitted work — and a
  signal now *stops* the script (a trap that only cleaned up let bash carry on with the backup directory
  deleted: every remaining mutation got applied and none restored, and it ate an afternoon). Run
  **`ANCHORS_ONLY=1 bash scripts/mutation-audit.sh`** first: seconds, checks all 66 anchors against the
  source, and a stale anchor is otherwise silently skipped — pass 5's fixes rotted four anchors in one
  sitting (`processGone`'s zombie line, both R4-07 prose anchors). Its verdict is the *set of failing test
  names* compared with a per-file baseline taken on a clean tree — an exit code says nothing while tests are
  red on purpose — and it refuses to apply an anchor that does not typecheck. Pass 5's final run:
  **66 mutations, every anchor matching, 64 die, the two survivors the accepted ones** (`flushLoose`'s
  `lateWrite`→`write`, `failure()`'s status choice). Pass 6 (tester) re-ran only the anchor check — all 66
  still match after its test-only changes — and left the ~50-minute full run to the pass-6 fixer, who owes
  it plus a mutation for whatever R6-01's fix turns out to be. Traps learned the hard way, still true: a multi-line anchor must be **one** single-quoted
  bash argument (a missing closing quote there swallows the following `run_mutation` lines and the failure
  only shows up as `bash -n` complaining), so run `bash -n scripts/mutation-audit.sh` and
  `ANCHORS_ONLY=1 …` before the long run; a mutation whose *testspec* names the wrong test file reads as a
  survival (the R4-06 guard inside the channel lock lives in `runLocked`, not in the start path — its line
  had to move to `run.test.ts`); a test that awaits a call before checking whether a process is alive can be
  satisfied by a product timeout doing the killing (F4-01's first test escaped its own mutation that way, and
  R5-02's and the late-spawn pin both check liveness **before** awaiting, with the ready timeout far away);
  and when a fix rewords a sentence, the mutation that deleted or inverted that sentence has to be re-anchored
  in the same commit — four were stale after the pass-5 prose fixes, and a skipped anchor is silent in the
  real run.
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
  it, the epoch is read on entry to `createChannel` (before `makeRoom`, F4-01/R5-02), a daemon spawned after
  the quit's walk is closed by `onSpawned` on sight (pinned via the `<envDir>.lock` recipe), and `getChannel`
  asks `processGone` before reusing a channel (F4-01, F4-02); a call that *joins* somebody else's channel
  creation waits through `untilAborted(…, joined=true)`, so its own cancel answers it promptly, and the two
  answers differ — the joiner held neither the daemon nor the slot (R5-01); one history record cannot delete
  the prompt section (shape-checked `definitions`, and an unreadable record prints as one line saying so);
  every log path an answer sends the model to is `existsSync`-checked at the answer (R5-04, and the settled
  `bg_stop` branch); the busy `bg_stop` answer quotes the process-table state when it is `T`/`t`/`D`/`Z` and
  only then drops the "blocks signals" guess (R5-05); and `bg_wait`'s listing never contradicts its own
  summary (R5-07).
- Three rules that must not change: a timeout never kills a cell, the daemon never uses
  `asyncio.run()`, and a test is never weakened to make a fix pass — argue it in AUDIT.md instead. Never
  delete an assertion from a passing test either: pass 2 nearly lost one to an editing slip in
  `test/lifecycle.test.ts` and caught it with `git diff | grep '^-'`. Four test lines have been *changed*
  (never loosened), each argued in AUDIT.md: pass 2's `expect(shown, …)` handed a string to `toBeLessThan`
  (which throws in vitest, so that R2-02 assertion had never run — it is `expect(shown.length, …)` now, same
  bound), pass 3's fixes changed R3-02's `expect(result.isError)` from `.toBe(false)` to `.toBeUndefined()`
  because the contract pinned green by `background.test.ts` is that a successful result carries no `isError`
  at all, and pass 4 widened one import in `test/prompt.test.ts` (`repoRoot`, `text as text2`) so a new test
  could read the README — no assertion in that file was touched. Pass 5's fixes changed one assertion line and
  widened one import (`lifecycle.test.ts`: `rmSync`): R5-02's `expect(existsSync(sideEffect)).toBe(false)`
  cannot be satisfied by any product, because the *retired* channel's legitimate cell creates that marker file
  first (pass 5's own measurement says the file reads `r5-02-hot r5-02-cold `); it is now two assertions on the
  file's *contents* — the cold marker absent, the hot one present — so the case proving it ran is pinned too.
  Pass 5's fixes also added assertions to one holding test (the aborted joiner must not claim it freed a slot:
  `not.toMatch(/free again|its daemon/)`), which is an addition, not a change. Pass 6 (tester) changed no
  assertion anywhere and added three tests of its own.
- **Housekeeping the suite never does:** `/tmp/replmode-agent-*` dirs from failed/aborted test runs and
  probe scripts accumulate (pass 6 cleared 119 of them plus a 1.1 GB stray venv `/tmp/scratch-env`); they
  are disposable — `find /tmp -maxdepth 1 -name 'replmode-agent-*' -mmin +30 -delete`. The real Python env
  is in `~/.cache/pi-replmode/`, never in `/tmp`. And vitest 5 has no `--reporter=basic` (startup error).
- Tests drive real processes only; where a daemon must misbehave (never ready, dies after answering,
  closes its protocol fd, dies on SIGINT, writes its complaint to the capture stream, emits a `fatal`
  frame) `test/lifecycle.test.ts` swaps in a **stub interpreter** via `PI_REPLMODE_ENV_DIR` — a dir with
  `.complete` plus an executable `bin/python`. Beware: the stub's script lives in a template literal, so
  any tool that re-indents the test file's lines breaks the stub with an `IndentationError`.
  `PI_REPLMODE_READY_TIMEOUT_MS` and `PI_REPLMODE_REQUIREMENTS` exist so those paths are reachable at all.
  A stub's self-reported pid file must be polled **for the parsed pid**, not for existence (`open()` creates it
  before the number lands; an empty read reads as a dead daemon). A scratch `npx tsx` script that uses the
  manager must end with `await getManager().quit()` or `process.exit(0)` — live children keep node alive and
  the script looks hung. `npx pytest` does not work (no such package) — use `npm run py:test -- [pytest args]`,
  and `npm run fmt` before expecting biome to pass. One manager and one agent dir per vitest **file**; inside
  a file, `vi.resetModules()` + a second `loadExtension({agentDir})` is how you simulate a reload — without
  the reset the module (whose paths are fixed at import) is reused and your temp dir is not where anything
  goes. Timing-sensitive suites: re-run any flake twice and report it.
- **If you need CPU load to time a test, `trap 'kill $(jobs -p) 2>/dev/null' EXIT INT TERM` first.**
  `SPINNERS=($!)` captures one pid, not the 24 job pids, so the "kill the spinners at the end" recipe
  orphans 23 busy-loops to PID 1: it happened in this project and burned **17.5 core-hours** (load average
  31 on 24 cores) before a sibling pi session found and killed them. Check `pgrep -c` after any load run.
- A stub env dir needs its `.complete`: without it `buildEnv` runs `uv venv` on the existing directory and
  the start failure the model sees is `uv venv failed for …: A directory already exists at: …`. To hold a
  call inside `ensureEnv` instead, leave `.complete` away and `mkdir <envDir>.lock` (the single-flight
  build's own lock, polled at 500 ms), then write `.complete` and remove the lock — that is how the
  late-spawn branch is reached without racing anything (DEV.md has the recipe).
- **`closeAll` only calls `quit()` when `reason === "quit"` or `PI_REPLMODE_KEEP_RUNNING=0`** — so with the
  default, `/new`, `/resume` and `/reload` do **not** bump the quit epoch, and the F4-01/R5-02 epoch
  machinery plus `droppedTasks`-across-boundaries behaviour are only reachable in a live process with
  `KEEP_RUNNING=0` set. Reachable, documented, and not the default: say which of the three a finding needs
  (pass 6's R6-01 names it in its own write-up).
