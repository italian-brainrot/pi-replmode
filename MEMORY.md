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
- Audit loop state: **pass 1, pass 2 and pass 2's fixes are in; the gate right now is `tsc` + `biome`
  green, 47 pytest green, and 153 vitest with 14 failing — those 14 are pass 3's red holding tests,
  committed on purpose.** Pass 2 found R2-01…R2-10; pass 3 (2026-11-01) found **R3-01…R3-10 (1 BUG,
  9 PAPERCUT)** and seven of them are *in* pass-2's fixes. Pass 3's section of
  [docs/AUDIT.md](docs/AUDIT.md) holds the findings, the re-check table and the mutation table; the
  "Pass 3 fixes" section, with what pass 4 should attack, is owed by the fixer.
- What pass 3 found, so a future session does not re-derive it: the 50 000 limit still does not cover
  everything pasted into an answer (the daemon's note ring — six entries, each unbounded, reached from a
  cell via `signal` handler `__name__` — and `definitions`, whose names can be 4095 chars and also leak
  into the history file and thus the prompt section); `channelFileStem` is not injective (a digested stem
  is a legal channel name, so two channels can share one daemon log, profile, history file and
  `lastHistoryByChannel` entry); a channel name starting with `-` dies in argparse (argv is passed as
  `--channel <name>`, not `--channel=<name>`); a start failure points at a daemon log that may not exist
  and could never hold the complaint; the capacity refusal says "all N channels are busy" when the
  occupiers are still starting; `bgStop` never reads `exec.deathNote`, so a background stop that took the
  channel down hides it; the prompt section and `promptGuidelines` repeat the group-kill promise without
  R2-09's process-group exception; `countOutput` runs before `Exec.appendNote` writes the full traceback
  into the exec log, so the truncation note under-states the file.
- Where the design is deliberately weak (know this before filing it as a bug; argue in AUDIT.md to change
  it): capture bytes that arrive **during** another cell's block are unattributable — the host flags a
  channel that has produced out-of-band bytes and says so in later results; per-exec capture pipes were
  rejected for deadlock (AUDIT "R2-07 decided"); the out-of-band note is sticky per channel, so it
  over-discloses once an orphan has been seen; a start-failure report waits only `STDIO_DRAIN_MS`
  (200 ms) for the dead daemon's stderr; `structuredContent.output` is the capture without the traceback;
  the banner and notes ride ~500 characters above 50 000 (the suite's `+5_000` slack encodes that).
  Pass 3's suggested cheap signal for the unattributable case — read `/proc/<daemon>/task/*/children` at
  exec end and say "this cell left processes running" — is argued, not implemented.
- Pass 2 attacked pass 1's fixes at the fix (eight `await` shapes, a self-made pipe on fd 1, an interrupt
  storm across exec boundaries, SIG_DFL + a pending SIGINT, EOF-vs-exit ordering, forged markers with real
  exec ids, `start_new_session=True`, parallel channel creation, reload with background tasks, hostile
  channel-name traversal). The interrupt design, the capture repair and teardown held; what broke was
  windowed truncation (R2-01), the cap under concurrency (R2-03), name sanitisation collisions and
  liveness keyed by file stem (R2-04), and the traceback having no share of the limit (R2-02) — all fixed.
  Pass 3 attacked those fixes themselves (a 3 MB final line in a windowed log, a cap of 1, a name that *is*
  another channel's digested stem, a wedged environment build holding a slot, `bg_stop` instead of an abort,
  a late complaint from a grandchild, a `fatal` frame followed by a real `ready`, a daemon that dies before
  its first boundary marker). The interrupt, the group kill, the cap arithmetic, the out-of-band note and
  the traceback budget held.
- Mutation testing is a tool now: `scripts/mutation-audit.sh` breaks one pass-2 fix at a time and shows
  which tests notice. Pass 3 ran it: two fixes were **not** pinned (the `evalue` clipping, and
  `flushLoose`'s use of `lateWrite`) and are pinned by new passing tests; `failure()`'s *choice* of
  status is still unpinned. Re-run it after any pass's fixes.
- Things that are easy to get wrong and are now pinned by tests: an interrupt must reach a cell parked on
  an `await` (there is no `asyncio.Task.throw`; the interrupt goes onto the future the cell task waits
  for, with cancel as the escalation); the SIGINT *disposition* is restored at every exec boundary; the
  daemon writes sentinels to its own `dup` of the capture pipe and repairs fd 1/2 per cell; closing a
  channel always group-kills; late capture bytes are attributed to the exec that produced them; the cap
  counts daemons that are still starting (`starting` ∪ live) and a failed start releases its slot; every
  file name and path a channel name becomes comes from `names.ts` and `Channel`'s paths (the daemon's
  `--log` argument included); the 50 000 limit covers the traceback as well as the capture; truncation
  offsets are log coordinates, and a windowed log's tail survives an oversized final line.
- Three rules that must not change: a timeout never kills a cell, the daemon never uses
  `asyncio.run()`, and a test is never weakened to make a fix pass — argue it in AUDIT.md instead. Never
  delete an assertion from a passing test either: pass 2 nearly lost one to an editing slip in
  `test/lifecycle.test.ts` and caught it with `git diff | grep '^-'`. The one pass-2 test line that
  pass-2-fixes changed is argued in AUDIT.md under "One test changed" and accepted by pass 3:
  `expect(shown, …)` handed a string to `toBeLessThan`, which throws in vitest, so that R2-02 length
  assertion had never run; it is `expect(shown.length, …)` now, same bound.
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
