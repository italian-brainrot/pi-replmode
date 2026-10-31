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
- Pass 1 of the tester↔fixer audit is in [docs/AUDIT.md](docs/AUDIT.md): 10 issues (R1-01…R1-10) plus
  three coverage gaps, demonstrated by 11 failing tests (6 vitest, 5 pytest) that are left in the tree
  on purpose. The gate is therefore *not* green until those are fixed; `npm run check` stops at the
  vitest failures, so run `npm run py:test` separately while they are red.
- Two rules that must not change: a timeout never kills a cell, and the daemon never uses
  `asyncio.run()`.
