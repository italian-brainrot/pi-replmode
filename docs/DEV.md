# Development notes

How to work on this repo without re-deriving everything. Design rationale lives in
[DESIGN.md](DESIGN.md); this file is the operational layer: commands, layout, and the things that
bite.

## Commands

```bash
npm run dev                 # watch src/, test/, python/ — re-runs the suite the change belongs to
npm run dev -- --all        # typecheck + lint + vitest + pytest, once (what CI runs)
npm run dev -- --py         # pytest only
npm run dev -- --fast       # skip tsc/biome while iterating
npm run dev -- -t interrupt # extra args go through to vitest or pytest
npm run check               # same as --all
npm run py:test -- -k await # pytest with a selector
npm run py:env              # build the Python env, print its path
```

Run a single host test file: `npx vitest --run test/background.test.ts`.

## Layout

```
python/replmode/   the channel daemon: wire.py (frames, sentinels), shell.py (IPython + pi ns),
                   daemon.py (raw asyncio loop, capture, interrupt, setvar)
python/tests/      pytest, driving the daemon over the real protocol. `test_daemon.py` holds the
                   `Daemon` client (two reader threads, frame/block waits); `test_hardening.py`
                   imports it rather than duplicating it
src/               the extension: index.ts (registration), manager.ts (policy: run/bg/truncation/
                   history/cap), channel.ts (one daemon process: pipes, execs, logs, interrupt),
                   wire.ts (frame parsing + CaptureSplitter), env.ts, paths.ts, names.ts (channel →
                   file names), format.ts, prompt.ts
test/              vitest, loading the extension the way pi does (test/helpers/extension.ts) and
                   talking to real daemons: run/background (the contract), capture/resilience/cap
                   (attribution, interrupts, lifecycle), lifecycle (stub interpreters: never-ready,
                   frame-then-death, protocol EOF), wire/format/prompt/registration/env

docs/AUDIT.md      the tester↔fixer log. Every failing test that documents a defect carries its
                   issue id (`R1-03`) in a comment, and the matching entry explains the fix.
scripts/dev.mjs    the watch loop
scripts/py.*.mjs   pytest / env building (they import src/env.ts through jiti so there is one
                   definition of where the environment lives)
scripts/mutation-audit.sh  break one fixed defect at a time and see which tests notice — the
                   "is this fix actually pinned?" check, run it after a pass's fixes
spikes/            the experiments that proved interrupt and formatter behaviour — read before M3
```

## Debugging

- **A channel's own output** is `~/.pi/agent/replmode/exec/<exec-id>.log` — that is the ground truth
  for "the tool said nothing".
- **The daemon's diagnostics** go to `~/.pi/agent/replmode/daemon/<channel>.log`, never to its
  stdout (stdout is the protocol) or stderr (stderr is the capture stream).
- Talk to a daemon by hand with a scratch script: `npx tsx scratch.ts` (tsx is a devDependency).
  `src/index.ts` is importable, but usually you want `manager.ts`'s `ReplmodeManager` directly.
- Reproduce a protocol question in Python alone:
  `python -m replmode --channel debug --log /tmp/debug.log` inside the env from `npm run py:env`,
  then write frame JSON lines to its stdin.
- **A daemon that does something the real one never does** (dies after answering, never becomes ready,
  closes its own descriptors): point `PI_REPLMODE_ENV_DIR` at a directory holding `.complete` and an
  executable `bin/python` script, and the host spawns that instead. `test/lifecycle.test.ts` does it —
  the host code under test is completely real, only the peer is a stub.
- **Is a fix actually pinned?** `bash scripts/mutation-audit.sh` applies one deliberate break to a fixed
  defect at a time, runs the test file that should notice, and reverts with `git checkout`. A mutation
  that changes nothing means the fix has no test behind it — pass 3 found two that way (the `evalue`
  clipping, and `flushLoose` going through `Exec.lateWrite`). Add the mutation to the script when you fix
  something, and keep the list short enough to run in under a minute.
- **Real pi smoke**, which catches what neither suite does (registration, prompt section, real
  harness): use a throwaway agent dir so the user's settings are untouched.

  ```bash
  mkdir -p /tmp/pi-smoke-agent
  cp ~/.pi/agent/auth.json ~/.pi/agent/models.json /tmp/pi-smoke-agent/
  # `qwen38-flash-next` is calibrated for thinking enabled: leave it on or the smoke test behaves oddly.
  printf '{"packages":["/home/qq/distrobox/ubuntu/Projects/pi-replmode"],"defaultProvider":"strata","defaultModel":"qwen38-flash-next","defaultThinkingLevel":"high"}' > /tmp/pi-smoke-agent/settings.json
  PI_CODING_AGENT_DIR=/tmp/pi-smoke-agent pi --no-builtin-tools -p "Use the run tool twice: set answer = 6*7, then print(answer)."
  ```

  It answers 42 when registration, the prompt section, and cross-call state all work.

## Things that bite

- **stdout is the protocol.** The daemon's first act is `proto = dup(1); dup2(2, 1); dup2(2, 2)` and
  it writes frames to `proto` only. Anything that lands on fd 1 afterwards corrupts the protocol,
  which is why capture is delimited by sentinels rather than assumed to be tidy. `proto` is usually fd
  3, and user code can close it: when a frame write fails, the daemon exits (`ProtocolGone`) rather
  than keeping a channel that can never answer. The host treats EOF on the frame stream as death too.
- **fd 1 and fd 2 belong to the cell.** The daemon keeps `capture_fd = dup(2)` and writes its sentinels
  there, and `_begin` puts fd 1/2 back on the capture pipe and rebuilds `sys.stdout`/`sys.stderr` if a
  cell closed the objects. So a redirect or a close is contained to the cell that did it — do not
  "simplify" this by writing sentinels to fd 2.
- **Never `asyncio.run()` in the daemon.** Its runner installs a SIGINT handler that cannot reach a
  cell stuck in synchronous code, and interrupt is the whole design. Use a raw event loop and leave
  CPython's default handler alone. Same reason: when the daemon masks signals around a cell, restore
  by *unblocking SIGINT*, not by re-applying the mask that was there before — that silently leaves
  interrupts dead for every later cell.
- **Two pipes, no ordering between them.** An `exec_end` frame can overtake the cell's own capture
  bytes. A host result is only complete when the closing sentinel has arrived; `CaptureSplitter`
  holds back only the bytes that could begin a sentinel, so ordinary output is not delayed and a
  sentinel split across any chunk boundary still reassembles. A death outranks a frame: `Exec.finalize`
  and `Channel.wait` report `dead` when the process went away, even if `exec_end` had arrived first.
- **Attribution of late bytes has a hard edge.** Bytes that arrive while no block is open go to the log of
  the exec whose block closed last (they came from its threads or children), under a header, capped at
  256 KB. Only output from before the first block ever opened is held for the next block. Bytes that
  arrive **while a block is open** cannot be told apart from that cell's own output — the whole channel
  shares one capture stream — so the host flags a channel that has produced out-of-band bytes and says so
  in every later result from it. Do not word that header, that note, or the DESIGN paragraph as if the
  host knows more than that (R2-07); and do not "fix" it with per-exec capture pipes without reading the
  deadlock argument in `docs/AUDIT.md`.
- **A channel name is three file names** — the daemon log, the history file, the IPython profile — and
  they must come from `names.ts`, the one place that keeps the mapping one-to-one. Naive sanitising puts
  `a/b` and `a_b` in one log, one history file and one sqlite profile; keying the "these channels are
  gone" note by the *file stem* instead of the record's real name tells the model a running channel
  died (R2-04). Two holes to keep in mind while it is verbatim-or-digest: a digested stem is itself a legal
  name, so the mapping has fixed points unless the digest is applied to names that already look digested
  (R3-03), and the name also travels as a daemon argument, where a leading `-` is read as an option
  (R3-02 — pass it as `--channel=<name>`).
- **Anything the host pastes into an answer is part of the size of the answer.** The 50 000 budget covers
  the capture and the traceback, but `deadResult` also pastes the daemon's note ring and the result pastes
  `definitions`, and both were bounded by *count* rather than by bytes, which a cell controls: a `signal`
  handler's `__name__` reaches a note, and Python identifiers may be 4095 characters (R3-01). Bound such
  fields with `oneLine` where they are quoted, and remember that `definitions` also lands in the history
  file and from there in the prompt section of every later session.
- **The 50 000-character limit covers the whole answer, not just the capture.** The traceback arrives in
  the `exec_end` frame and is appended after the capture, so it needs its own share of the budget or a
  cell that raises with a row of data in its message returns a result of unbounded size (R2-02). If you
  shorten anything, put the full text in the exec log and bind the nonce global — that is the deal every
  shortening here makes.
- **An interrupt has two paths.** Running bytecode: CPython's default handler raises in the cell.
  Parked on an `await`: the loop catches the `KeyboardInterrupt` and `Runner.interrupt_cell` puts it on
  the future the cell task waits for (`asyncio.Task` has no `throw`). Keep the raw loop and the default
  handler, and keep the interrupt reaching both paths — `test_hardening.py` pins both.
- **The manager lives on `globalThis`.** `/reload` clears pi's module cache but keeps the process and
  its pipes; a manager rebuilt per module would orphan running daemons. Consequence in tests: one
  manager per test *file* (vitest forks + `isolate: true`), so anything the manager caches at
  construction — e.g. the channel cap — is shared by every test in the file. The cap is read per
  channel creation for exactly this reason.
- **A timeout never kills a cell.** It detaches the call. Only `interrupt()` ends a cell, and only
  `bg_stop { kill: true }` ends a channel. If you change this, the interrupt tests will tell you.
- **Closing a channel always group-kills.** `Channel.close` sends `shutdown`, waits, and then takes the
  process group down regardless — the daemon answers `shutdown` quickly, so an escalation that only
  fires when it does not would never run, and every server or build the cell started would survive the
  channel that made it. The exception is written down in three places (the `channel.ts` header,
  DESIGN, and the `kill` parameter text): a child that left the group is out of reach.
- **The channel cap counts daemons that are still starting.** `run` is parallel and the prompt recommends
  one channel per piece of work, so five calls on five new names arrive in one tick; counting only
  daemons that have answered gives five processes under a cap of 2 (R2-03). Anything that moves the
  `channels.set` / `starting.delete` handoff has to keep the union of the two maps correct.
- **vitest timing**: `bg_wait` returns when *any* task finishes, so assertions about elapsed time
  must be relative to when each task was started, not to the cell's own length. Anything that waits on
  real signal delivery is timing-sensitive; prefer `waitFor` over fixed sleeps, and never assert on
  *where* a racy interrupt landed (a SIGINT left pending across an exec boundary may be reported as the
  cell or as the loop, and both are correct).
- **Env variables the suites use**: `PI_REPLMODE_MAX_CHANNELS`, `PI_REPLMODE_READY_TIMEOUT_MS`
  (makes the never-ready daemon testable), `PI_REPLMODE_REQUIREMENTS` and `PI_REPLMODE_ENV_DIR` (make
  "changed pins, new environment" testable), `PI_REPLMODE_KEEP_RUNNING`. All are read per use, not at
  manager construction, for exactly this reason.
- **biome must not format markdown.** `files.includes` excludes `*.md`: AGENTS.md is the user's file,
  and a formatter pass that re-indents it is a semantic change. Same reason `*.py` is excluded —
  there is no Python formatter configured.
- **IPython 9** requires `run_cell_async(code, transformed_cell=shell.transform_cell(code),
  store_history=True)`; a raw cell raises `TypeError`. Traceback colour is off
  (`colors="NoColor"`, `ipython.color_scheme`), and plain-text-only display formatting is deliberate
  until the display pipeline (M3) exists.
