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
- Audit loop state: **passes 1–4 are in. Pass 4 (2026-11-01) was a tester and reported R4-01…R4-09 —
  2 BUG, 7 PAPERCUT, eight of them inside pass 3's own fixes — and they are NOT fixed yet.** Thirteen
  holding tests are red on purpose (`limits` 2, `names` 1, `lifecycle` 3, `resilience` 3, `cap` 1, `prompt`
  3), so the suite is 185 = 172 pass + 13 fail while `tsc`, `biome` and 47 pytest are green. Read
  [docs/AUDIT.md](docs/AUDIT.md) §"Pass 4 audit — 2026-11-01 (tester)": the per-finding write-ups, the
  "Re-checking pass 3's fixes, at the fix" table, "Probed and left alone", and "Handoff to the fixer
  (pass 4)" with a suggested order (R4-06 first) and what each fix must not break. Never weaken a test;
  *adding* an assertion to one is fine, and is how unpinned fixes get pinned.
- What pass 4 found, in one line each (full write-ups in AUDIT): **R4-01** the prompt section and the
  restart notification quote `note.channel`/`note.code` raw — bounded only at the write, so an old history
  file or a legal newline in a name reaches every later prompt; **R4-02** `lastHistoryByChannel`'s stem
  fallback keys a note by a *file stem*, so a record missing its `channel` field reports a live channel as
  lost under a name it never had; **R4-03** a daemon that never reports `ready` gets R3-07's write-and-point
  treatment *never* (`reportStartFailure` hangs off `onExit`), so that one start failure carries no
  diagnosis and the log appears unnamed ~0.5 s later; **R4-04** `bgStop`'s settled branch never reaches
  `stoppedResult`, so "already finished (completed)" says nothing about the channel that died; **R4-05**
  the capacity refusal attributes the cap (4) to `PI_REPLMODE_MAX_CHANNELS` after ignoring its value;
  **R4-06** an aborted `run` does not abandon the channel it was starting — it holds the slot and the daemon
  for the whole ready timeout, and sends its cell if the channel arrives late (AUDIT argues this is fixable
  without a new tool surface: thread the signal into `getChannel`/`startChannel`); **R4-07** the 200-char
  name rule is on no surface where a name is chosen, and the refusal says "under 200" while accepting 200;
  **R4-08** README's "the limit covers the whole answer" is false — measured a legitimate 51 030-character
  answer (36 KB capture + 13 KB traceback + 30 long definitions, nothing truncated); **R4-09** killing a
  channel drops its tasks, the kill answer names no log, and a later `bg_stop` blames the 3-day retention
  window.
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
  legibility choices, not derived; and **nothing can free a channel that is still starting** — a wedged
  creation holds a slot for up to `PI_REPLMODE_READY_TIMEOUT_MS` and `bg_stop` has no task id to take, which
  R3-04's wording now says out loud instead of pretending the model can act. Pass 3's suggested cheap signal
  for the unattributable case — read `/proc/<daemon>/task/*/children` at exec end and say "this cell left
  processes running" — is still argued, not implemented.
- Pass 2 attacked pass 1's fixes; pass 3 attacked pass 2's; pass 4 attacked the pass-3 fixes, and eight of
  its nine findings landed there. Held under attack and re-pinned: the interrupt design (both paths), the
  group kill and its process-group exception, the cap arithmetic (a cap of 1, and failed starts releasing a
  slot), the out-of-band note, the traceback budget, windowed truncation coordinates, the name encoder's
  shape (property test), the history-file upgrade path, R3-02's argv, R3-06's prose, R3-09's two units, and
  R3-10's attribution. Did not hold, now reported: quoting a field only at its write (R4-01), a file stem
  used as a channel key (R4-02), a start path that never reaches its own reporting (R4-03), a fixed branch
  of a three-branch function (R4-04, R4-09), an env value reported after being ignored (R4-05), an abort
  that is not threaded through the thing it cancels (R4-06), a rule that exists only in the error that
  enforces it (R4-07), and a README claim the suite's `+5_000` slack had been hiding (R4-08).
- Mutation testing is a tool now: `scripts/mutation-audit.sh`, ~50 lines, takes a label substring
  (`bash scripts/mutation-audit.sh R3-0`); the full list is 36 mutations and **~14 minutes**, and **requires
  a committed tree** (it reverts with `git checkout`). Its verdict is the *set of failing test names*
  compared with a per-file baseline taken on a clean tree — an exit code says nothing while tests are red on
  purpose — and it refuses to apply an anchor that does not typecheck. Anchors rot: pass 4 found three that
  had stopped matching the code's shape (M4, `keepNewest`, R3-10) and had been silently skipped; re-find the
  anchor, never delete the line. Pass 4's run: 34 die, and the two survivors are the accepted ones —
  `flushLoose`'s `Exec.lateWrite` → `Exec.write` (both append in the only reachable case; the *header* is a
  separate mutation that does die) and `failure()`'s choice of status (the enum has no "rejected" value).
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
