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
- Audit pass 1 is **done and fixed** (R1-01…R1-10 + gaps R1-11…R1-13). Audit **pass 2 ran 2026-11-01 and
  found 10 more: R2-01…R2-04 are BUGs, R2-05…R2-09 PAPERCUTs, R2-10 MISSING-COVERAGE.** Ten vitest tests
  are committed **red on purpose** to hold them, so the gate is deliberately red at vitest: tsc ✓,
  biome ✓, **114 vitest (104 pass / 10 fail)**, **47 pytest ✓**. Red tests live in `test/format.test.ts`,
  `test/capture.test.ts` (×2), `test/honesty.test.ts` (×2), `test/names.test.ts` (×2), `test/cap.test.ts`,
  `test/lifecycle.test.ts` (×2). R2-01 is a regression **from the R1-09 fix**; read the "Re-checking pass
  1's fixes" table in [docs/AUDIT.md](docs/AUDIT.md) before touching any of that area.
- Pass 2 attacked the pass-1 fixes at the fix, not the symptom (eight `await` shapes for the interrupt, a
  self-made pipe on fd 1, an interrupt storm across exec boundaries, SIG_DFL + a pending SIGINT,
  EOF-vs-exit ordering, forged markers carrying real exec ids, `start_new_session=True`, parallel channel
  creation, reload with background tasks, hostile channel-name traversal). The interrupt design, the
  capture repair and channel teardown held. What did not: windowed truncation drops the tail (R2-01), the
  channel cap is not enforced under concurrency (R2-03), sanitised channel names collide and a live
  channel is announced to the model as lost (R2-04), and the traceback gets no share of the 50 000-char
  limit (R2-02).
- Things that are easy to get wrong and are now pinned by tests: an interrupt must reach a cell parked
  on an `await` (there is no `asyncio.Task.throw`; the interrupt goes onto the future the cell task
  waits for, with cancel as the escalation); the SIGINT *disposition* is restored at every exec boundary;
  the daemon writes sentinels to its own `dup` of the capture pipe and repairs fd 1/2 per cell; closing
  a channel always group-kills; late capture bytes are attributed to the exec that produced them.
- Three rules that must not change: a timeout never kills a cell, the daemon never uses
  `asyncio.run()`, and a test is never weakened to make a fix pass — argue it in AUDIT.md instead. Never
  delete an assertion from a passing test either: pass 2 nearly lost one to an editing slip in
  `test/lifecycle.test.ts` and caught it with `git diff | grep '^-'`.
- Tests drive real processes only; where a daemon must misbehave (never ready, dies after answering,
  closes its protocol fd) `test/lifecycle.test.ts` swaps in a **stub interpreter** via
  `PI_REPLMODE_ENV_DIR` — a dir with `.complete` plus an executable `bin/python`.
  `PI_REPLMODE_READY_TIMEOUT_MS` and `PI_REPLMODE_REQUIREMENTS` exist so those paths are reachable at all.
  `npx pytest` does not work (no such package) — use `npm run py:test -- [pytest args]`, and `npm run fmt`
  before expecting biome to pass. One manager and one agent dir per vitest **file**; inside a file,
  `vi.resetModules()` + a second `loadExtension({agentDir})` is how you simulate a reload — without the
  reset the module (whose paths are fixed at import) is reused and your temp dir is not where anything
  goes. Timing-sensitive suites: re-run any flake twice and report it.
