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
- Audit pass 1 is **done and fixed** (issues R1-01…R1-10 + gaps R1-11…R1-13, all pinned by tests);
  [docs/AUDIT.md](docs/AUDIT.md) has the pass-1 entries and a "Pass 1 fixes" section saying what each
  fix is and what to try to break. Gate: `npm run check` green — tsc, biome, **95 vitest**, **42
  pytest**. A pass-2 tester may run next; if it finds nothing above BUG, the loop ends.
- Things that are easy to get wrong and are now pinned by tests: an interrupt must reach a cell parked
  on an `await` (there is no `asyncio.Task.throw`; the interrupt goes onto the future the cell task
  waits for, with cancel as the escalation); the SIGINT *disposition* is restored at every exec boundary;
  the daemon writes sentinels to its own `dup` of the capture pipe and repairs fd 1/2 per cell; closing
  a channel always group-kills; late capture bytes are attributed to the exec that produced them.
- Three rules that must not change: a timeout never kills a cell, the daemon never uses
  `asyncio.run()`, and a test is never weakened to make a fix pass — argue it in AUDIT.md instead.
- Tests drive real processes only; where a daemon must misbehave (never ready, dies after answering,
  closes its protocol fd) `test/lifecycle.test.ts` swaps in a **stub interpreter** via
  `PI_REPLMODE_ENV_DIR`. `PI_REPLMODE_READY_TIMEOUT_MS` and `PI_REPLMODE_REQUIREMENTS` exist so those
  paths are reachable at all.
