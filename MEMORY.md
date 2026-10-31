# MEMORY.md

pi-replmode: a pi extension that replaces pi's one-shot tools with one stateful IPython REPL.
Registers `run`, `bg_wait`, `bg_stop` only — it never touches the active tool set.

- Design, decisions, milestones: [docs/DESIGN.md](docs/DESIGN.md). Commands, debugging, gotchas:
  [docs/DEV.md](docs/DEV.md). README is for users; AGENTS.md is the user's, do not reformat it.
- One Python process per channel (`python/replmode/`), JSON frames on a saved fd 1, all code output
  captured at fd level on stderr with `PIRB` sentinels. TypeScript side in `src/`.
- Status: M1 (core) and M2 (channels, timeouts→background, bg_wait/bg_stop, reload re-adoption) are
  done and covered by real-process tests (pytest + vitest). M3 = display/images, `pi.read_image`,
  `pi.ask`, `pi.run_subagent` over a `call`/`call_reply` pump — not started.
- Audit loop state: **pass 1 and pass 2 are both fixed and the gate is green — `tsc`, `biome`, 123
  vitest, 47 pytest** (two back-to-back runs, identical). Pass 2 (2026-11-01) found R2-01…R2-10 (4 BUG,
  5 PAPERCUT, 1 gap); every fix is pinned and [docs/AUDIT.md](docs/AUDIT.md) has a **"Pass 2 fixes"**
  section saying what each fix is, what was decided, and what a pass-3 tester should attack. Pass 3 is
  due and must attack those fixes at the fix, the way pass 2 attacked pass 1's.
- Where pass 2's fixes are deliberately weak (know this before filing it as a bug, and argue in AUDIT.md
  if you want it changed): capture bytes that arrive **during** another cell's block are unattributable —
  the host flags a channel that has produced out-of-band bytes and says so in later results, and the
  per-exec-pipe alternative was rejected for deadlock (AUDIT "R2-07 decided"); a start-failure report
  waits only `STDIO_DRAIN_MS` (200 ms) for the dead daemon's stderr; `structuredContent.output` is the
  capture without the traceback; the out-of-band note is sticky per channel, so it over-discloses once an
  orphan has been seen.
- Pass 2 attacked the pass-1 fixes at the fix, not the symptom (eight `await` shapes for the interrupt, a
  self-made pipe on fd 1, an interrupt storm across exec boundaries, SIG_DFL + a pending SIGINT,
  EOF-vs-exit ordering, forged markers carrying real exec ids, `start_new_session=True`, parallel channel
  creation, reload with background tasks, hostile channel-name traversal). The interrupt design, the
  capture repair and channel teardown held. What did not: windowed truncation dropped the tail (R2-01),
  the channel cap was not enforced under concurrency (R2-03), sanitised channel names collided and a live
  channel was announced to the model as lost (R2-04), and the traceback had no share of the 50 000-char
  limit (R2-02). All four are fixed; pass 3 should re-attack the fixes themselves.
- Things that are easy to get wrong and are now pinned by tests: an interrupt must reach a cell parked
  on an `await` (there is no `asyncio.Task.throw`; the interrupt goes onto the future the cell task
  waits for, with cancel as the escalation); the SIGINT *disposition* is restored at every exec boundary;
  the daemon writes sentinels to its own `dup` of the capture pipe and repairs fd 1/2 per cell; closing
  a channel always group-kills; late capture bytes are attributed to the exec that produced them; the
  cap counts daemons that are still starting (`starting` ∪ live); every file name a channel name becomes
  comes from `names.ts`; the 50 000 limit covers the traceback as well as the capture.
- Things that are easy to get wrong and are now pinned by tests: an interrupt must reach a cell parked
  on an `await` (there is no `asyncio.Task.throw`; the interrupt goes onto the future the cell task
  waits for, with cancel as the escalation); the SIGINT *disposition* is restored at every exec boundary;
  the daemon writes sentinels to its own `dup` of the capture pipe and repairs fd 1/2 per cell; closing
  a channel always group-kills; late capture bytes are attributed to the exec that produced them.
- Three rules that must not change: a timeout never kills a cell, the daemon never uses
  `asyncio.run()`, and a test is never weakened to make a fix pass — argue it in AUDIT.md instead. Never
  delete an assertion from a passing test either: pass 2 nearly lost one to an editing slip in
  `test/lifecycle.test.ts` and caught it with `git diff | grep '^-'`. The one line of pass 2's tests that
  pass-2-fixes did change is argued in AUDIT.md under "One test changed": `expect(shown, …)` was a string
  being handed to `toBeLessThan`, which throws in vitest, so that R2-02 length assertion had never run at
  all; it is `expect(shown.length, …)` now, same bound.
- Tests drive real processes only; where a daemon must misbehave (never ready, dies after answering,
  closes its protocol fd, dies on SIGINT, writes its complaint to the capture stream) `test/lifecycle.test.ts`
  swaps in a **stub interpreter** via `PI_REPLMODE_ENV_DIR` — a dir with `.complete` plus an executable
  `bin/python`. Beware: the stub's script lives in a template literal, so any tool that re-indents the
  test file's lines breaks the stub with an `IndentationError`.
  `PI_REPLMODE_READY_TIMEOUT_MS` and `PI_REPLMODE_REQUIREMENTS` exist so those paths are reachable at all.
  `npx pytest` does not work (no such package) — use `npm run py:test -- [pytest args]`, and `npm run fmt`
  before expecting biome to pass. One manager and one agent dir per vitest **file**; inside a file,
  `vi.resetModules()` + a second `loadExtension({agentDir})` is how you simulate a reload — without the
  reset the module (whose paths are fixed at import) is reused and your temp dir is not where anything
  goes. Timing-sensitive suites: re-run any flake twice and report it.
