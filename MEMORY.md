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
- Audit loop state: **passes 1, 2 and 3 and all three sets of fixes are in; the gate is green — `tsc`,
  `biome`, 164 vitest, 47 pytest, two identical full runs — and pushed.** Pass 2 found R2-01…R2-10; pass 3
  (2026-11-01) found R3-01…R3-10 (1 BUG, 9 PAPERCUT), seven of them inside pass 2's fixes, and the fixer
  added F3-01 (`ename` unbounded) and F3-02 (a channel name of any length). **Pass 4 (a fresh tester) is
  next**: read [docs/AUDIT.md](docs/AUDIT.md) §"Pass 3 fixes — 2026-11-01 (fixer)" — it has the fix-by-fix
  account, what each fix leaves deliberately weak, a "*Pass 4 should try:*" list per finding, the mutation
  table and a "Handoff to pass 4" list. Never weaken a test; *adding* an assertion to one is fine, and is
  how three unpinned pass-3 fixes got pinned.
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
  legibility choices, not derived; and **nothing can free a channel that is still starting** — a wedged
  creation holds a slot for up to `PI_REPLMODE_READY_TIMEOUT_MS` and `bg_stop` has no task id to take, which
  R3-04's wording now says out loud instead of pretending the model can act. Pass 3's suggested cheap signal
  for the unattributable case — read `/proc/<daemon>/task/*/children` at exec end and say "this cell left
  processes running" — is still argued, not implemented.
- Pass 2 attacked pass 1's fixes; pass 3 attacked pass 2's; **pass 4 should attack the pass-3 fixes.** Held
  under attack and re-pinned: the interrupt design (both paths), the group kill and its process-group
  exception, the cap arithmetic (a cap of 1, and failed starts releasing a slot), the out-of-band note, the
  traceback budget, windowed truncation coordinates, the name encoder's shape, the history-file upgrade
  path. Did not hold, now fixed: unbounded pasted fields (R3-01), name-mapping injectivity (R3-03), the
  start-failure pointer at a file that did not exist (R3-07), stale truncation totals (R3-09), a missing
  exception in the prompt surface (R3-06), `bg_stop` ignoring the death note (R3-05), argv splitting a
  channel name (R3-02), `readdirSync` deciding which history record wins (R3-08), and startup bytes labelled
  as a cell's late output (R3-10).
- Mutation testing is a tool now: `scripts/mutation-audit.sh`, ~30 lines, takes a label substring
  (`bash scripts/mutation-audit.sh R3-0`); a full pass is ~3 min and **requires a committed tree** (it
  reverts with `git checkout`). The pass-3 run showed three of its own fixes were unpinned (the capacity
  wording, `bg_stop`'s "variables", and two copies of one bound masking each other) — pinned with added
  assertions/tests, then re-run: all die. Still surviving on purpose: `flushLoose`'s `Exec.lateWrite` →
  `Exec.write` (both append in the only reachable case; the *header* is a separate mutation that does die)
  and `failure()`'s choice of status (the enum has no "rejected" value).
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
  survives an oversized final line; and a successful `run` result has no `isError` key at all.
- Three rules that must not change: a timeout never kills a cell, the daemon never uses
  `asyncio.run()`, and a test is never weakened to make a fix pass — argue it in AUDIT.md instead. Never
  delete an assertion from a passing test either: pass 2 nearly lost one to an editing slip in
  `test/lifecycle.test.ts` and caught it with `git diff | grep '^-'`. Two test lines have been *changed*
  (never loosened), both argued in AUDIT.md under "One test changed": pass 2's `expect(shown, …)` handed a
  string to `toBeLessThan` (which throws in vitest, so that R2-02 assertion had never run — it is
  `expect(shown.length, …)` now, same bound), and the pass-3 fixes changed R3-02's `expect(result.isError)`
  from `.toBe(false)` to `.toBeUndefined()`, because the contract pinned green by `background.test.ts` is
  that a successful result carries no `isError` at all, so no working code could have satisfied the old one.
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
