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
                   frame-then-death, protocol EOF), limits (what a result may cost), names (channel
                   names and the files they become), prompt/registration (the model-facing surface),
                   wire/buffers (pure arithmetic: the capture splitter, the bounded startup buffer)

docs/AUDIT.md      the tester↔fixer log. Every failing test that documents a defect carries its
                   issue id (`R1-03`) in a comment, and the matching entry explains the fix.
scripts/dev.mjs    the watch loop
scripts/py.*.mjs   pytest / env building (they import src/env.ts through jiti so there is one
                   definition of where the environment lives)
scripts/mutation-audit.sh  break one fixed defect at a time and see which tests notice — the
                   "is this fix actually pinned?" check, run it after a pass's fixes; it takes a label
                   filter (`bash scripts/mutation-audit.sh R3-0`), and the full list is 79 mutations /
                   ~80 minutes (it typechecks each mutation and re-runs a baseline per test file).
                   `ANCHORS_ONLY=1 bash scripts/mutation-audit.sh` checks that every anchor still
                   matches the source and runs nothing: do that first, it takes seconds
scripts/clean-tmp.sh  delete the suite's scratch dirs under /tmp (agent dirs, cwd dirs, name dirs)
                   that failed and hand-written runs leave behind; safe, the real env is in ~/.cache
scripts/smoke-abort-start.sh  the real-pi abort smoke: a pty, the interactive TUI, and the byte for Esc
                   (SIGINT to `pi -p` is a hard kill that runs no shutdown, so nothing else can reach this)
scripts/smoke-prompt-surface.sh  three real pi runs against a throwaway agent dir, reading the system
                   sections out of the session file: no `<replmode>` tag, the lost-channel listing inside
                   pi's `rules`, and nothing from this extension in a prompt the user overrode with
                   `SYSTEM.md` (costs three model calls; the session files stay for inspection)
spikes/            the experiments that proved interrupt and formatter behaviour — read before M3
```

## Debugging

- **A channel's own output** is `~/.pi/agent/replmode/exec/<exec-id>.log` — that is the ground truth
  for "the tool said nothing".
- **The daemon's diagnostics** go to `~/.pi/agent/replmode/daemon/<channel>.log`, never to its
  stdout (stdout is the protocol) or stderr (stderr is the capture stream).
- Talk to a daemon by hand with a scratch script: `npx tsx scratch.ts` (tsx is a devDependency).
  `src/index.ts` is importable, but usually you want `manager.ts`'s `ReplmodeManager` directly.
  **Set `PI_CODING_AGENT_DIR` (and `PI_REPLMODE_ENV_DIR` etc.) in the environment, not at the top of the
  script**: ESM imports are hoisted, so `paths.ts` has already resolved `getAgentDir()` by the time the
  first line of your script runs, and a scratch script that means to use a temp dir will quietly write
  channels into the real `~/.pi/agent/replmode/` instead. `PI_CODING_AGENT_DIR=/tmp/x npx tsx scratch.ts`.
  **And end the script with `await getManager().quit()`** (or `process.exit(0)`): the manager holds live
  child processes, node keeps its event loop alive while they run, and a script that has printed everything
  you asked for will sit there holding its daemons until you interrupt it.
- Reproduce a protocol question in Python alone:
  `python -m replmode --channel debug --log /tmp/debug.log` inside the env from `npm run py:env`,
  then write frame JSON lines to its stdin.
- **A daemon that does something the real one never does** (dies after answering, never becomes ready,
  closes its own descriptors): point `PI_REPLMODE_ENV_DIR` at a directory holding `.complete` and an
  executable `bin/python` script, and the host spawns that instead. `test/lifecycle.test.ts` does it —
  the host code under test is completely real, only the peer is a stub.
  Two edges of that trick. The directory needs `.complete`: without it `buildEnv` decides the environment
  must be built and runs `uv venv` on the existing directory, and the model's start-failure answer becomes
  `uv venv failed for …: A directory already exists at: …` (measured, and it cost me a debugging detour).
  If the point *is* to hold the call inside `ensureEnv`, leave `.complete` away and create a directory
  named `<envDir>.lock` — that is the single-flight build's own `mkdir` lock, polled every 500 ms — then
  write `.complete` and remove the lock to let the build finish. That is how the "daemon spawned after the
  quit began walking" branch is reached deterministically.
- **The scratch space these tests use is disposable, and it accumulates.** Every `loadExtension` makes a
  `/tmp/replmode-agent-XXXX/` and most of them are removed by `dispose()`; failed runs, aborted runs and
  hand-written probe scripts leave the rest behind, along with `/tmp/replmode-cwd-*` and
  `/tmp/replmode-names-*`. Nothing pins those paths, so `bash scripts/clean-tmp.sh` is safe whenever `/tmp`
  looks fat (it takes an age in minutes, 30 by default). Pass 6 cleared 119 agent dirs plus a 1.1 GB
  `/tmp/scratch-env` venv; a full audit pass adds a few hundred cwd and name dirs. The environment that
  actually matters is not in `/tmp`: it is `${XDG_CACHE_HOME:-~/.cache}/pi-replmode/py-env-<hash>`.
- **vitest 5 has no `basic` reporter.** `npx vitest --run test/lifecycle.test.ts --reporter=basic` fails at
  startup with "Failed to load custom Reporter"; the default reporter already prints per-test lines, and
  `grep -E "×|✓|Tests |Test Files"` is what pass 6 filtered it with.
- **Measuring a timing-sensitive test needs CPU load, and a load harness leaks if you are careless.**
  `SPINNERS=($!)` captures **one** pid, not the job pids: `for i in $(seq 24); do (while :; do :; done) &
  done` followed by `kill "${SPINNERS[@]}"` kills one spinner and orphans 23 to PID 1, each pinned at a
  core. That happened in this project and burned 17.5 core-hours before anyone noticed. Do this instead,
  and check afterwards with `pgrep -c loadrun || true`:

  ```bash
  trap 'kill $(jobs -p) 2>/dev/null' EXIT INT TERM
  for i in $(seq "$(nproc)"); do (while :; do :; done) & done
  for run in 1 2 3 4; do npx vitest --run test/lifecycle.test.ts; done
  ```

  Four loaded runs of `lifecycle.test.ts` is the check pass 6 used for its timing-sensitive tests: 31/31
  each time, no flakes.
- **Is a fix actually pinned?** `bash scripts/mutation-audit.sh` applies one deliberate break to a fixed
  defect at a time, runs the test file that should notice, and restores the file from a copy taken
  before the break (it no longer reverts with `git checkout`, which used to eat uncommitted work).
  A mutation that changes nothing means the fix has no test behind it — pass 3 found two that way (the
  `evalue` clipping, and `flushLoose` going through `Exec.lateWrite`), and the pass-3 fixes found three of their
  own (the capacity wording, `bg_stop`'s "variables", and two copies of one bound masking each other).
  Add the mutation to the script when you fix something — prose fixes get mutations too. Check the new
  anchor before the long run with `ANCHORS_ONLY=1 bash scripts/mutation-audit.sh` (seconds, runs no
  tests; a stale anchor is skipped silently by a real run), and pass a label substring (`… R3-0`)
  while iterating; the whole list is 77 mutations and about eighty minutes, so iterate with a filter.
  `test/anchors.test.ts` parses the script and fails the normal suite when an anchor no longer matches its
  source, when a label is reused (the filter then can never select it alone), or when a replacement is
  identical to its anchor — so a rotted anchor is a red test rather than a surprise an hour into a sweep.
  Two things it guards against, both learned the hard way: a mutation is applied only if the tree still
  `tsc`s (an anchor that no longer matches the code's shape is skipped loudly rather than counted as a
  survival — three anchors had rotted that way), and a mutation counts as dead only when the **set of
  failing test names** changes, because a suite with tests red on purpose fails no matter what you break.
  A rejected mutation is not in the total, and the rejections are cryptic unless you know the rule: the
  replacement has to leave the file parseable and the code reachable. Pass 6 lost two anchors to this — one
  dropped the closing backtick of a template literal, and neutering a guard with `if (false && x)` reported
  an unrelated `TS18048` because the constant `false` stops the narrowing an `if (!x) throw` above it
  establishes. Use a sub-condition that is false but not constant (`x && this.maxChannels < 0`).
- **Real pi smoke**, which catches what neither suite does (registration, prompt surface, real
  harness): use a throwaway agent dir so the user's settings are untouched.

  ```bash
  mkdir -p /tmp/pi-smoke-agent
  cp ~/.pi/agent/auth.json ~/.pi/agent/models.json /tmp/pi-smoke-agent/
  # `qwen38-flash-next` is calibrated for thinking enabled: leave it on or the smoke test behaves oddly.
  printf '{"packages":["/home/qq/distrobox/ubuntu/Projects/pi-replmode"],"defaultProvider":"strata","defaultModel":"qwen38-flash-next","defaultThinkingLevel":"high"}' > /tmp/pi-smoke-agent/settings.json
  PI_CODING_AGENT_DIR=/tmp/pi-smoke-agent pi --no-builtin-tools -p "Use the run tool twice: set answer = 6*7, then print(answer)."
  ```

  It answers 42 when registration, the prompt surface, and cross-call state all work. Two more prompts are
  worth running after anything that touches startup or death: a channel named `-smoke-dash` (a leading dash
  must not reach argparse as a separate token, and the definitions note should still be there), and
  `import os; os._exit(3)` followed by a second call on the same channel (the death reported, a fresh
  channel next). For `bg_stop`, start a background cell that installs
  `signal.signal(signal.SIGINT, lambda *a: os._exit(7))` and stop it: the answer must say the channel went
  with the cell, and since R4-09 that answer ends with `Log: <path>`.

  **Ask for `--mode json` when the claim under test is about a result's fields**, because "tell me what the
  tool returned" routes the truth through a model that paraphrases it. `pi --no-builtin-tools --mode json -p
  '…'` prints one JSON event per line; the `tool_execution_end` events carry the real `content`, `details`
  and `structuredContent`, so `grep`/`jq` for those is how you check that a field is present, absent, or
  named honestly. Pass 6 used it for R6-03: `bg_stop` on an id this process never heard of must name no
  channel at all, and a `bg_wait` listing must not claim one channel for an answer whose rows name one each
  — both now return `details` with no `channel` key, and pi renders that without complaint. Chaining four
  calls in one prompt (`run` in the background, `bg_wait` with a short timeout, `bg_stop {kill: true}`, then
  `bg_stop` of the same id again) exercises the stopped, dropped and unknown-task branches in one run, and it
  is the only way to see `details` at all for a branch the suite reaches with stubs.

  The aborted-start smoke does not work with `-p`: SIGINT in print mode is a hard kill — no
  `session_shutdown` runs and no abort fires (measured: an idle daemon survives SIGINT and is closed only
  by a clean exit). `scripts/smoke-abort-start.sh` does it in the real interactive TUI under a pty, typing
  the prompt, waiting for the daemon to exist, and pressing Esc as a byte. It builds its own slow
  interpreter — an env dir whose `bin/python` sleeps 25s before exec'ing a real one, at
  `/tmp/pi-smoke-env-slow` unless `STUB_ENV=` points elsewhere — and raises `PI_REPLMODE_READY_TIMEOUT_MS`
  so the call is still starting when Esc lands. It passes when the tool
  answers `call aborted while channel "…" was still starting`, the cell's side effect is absent, and no
  daemon with that `--channel=` is left running.

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
  256 KB. Only output from before the first block ever opened is held for the next block — that buffer
  (`loose`, 64 KB) is trimmed inside its oldest chunk by `keepNewest` and never dropped whole, so the
  newest bytes survive; for a channel that never reported `ready`, the host writes what it received into
  the daemon's log path and points the model at that file, because the daemon never opened it and a
  `log`-frame file could never have held capture-stream bytes (R3-07). Bytes that arrive **while a block is
  open** cannot be told apart from that cell's own output — the whole channel shares one capture stream —
  so the host flags a channel that has produced out-of-band bytes and says so in every later result from
  it. Do not word that header, that note, or the DESIGN paragraph as if the host knows more than that
  (R2-07); the header for pre-first-block bytes is a different one, because no cell had ended (R3-10). Do
  not "fix" any of it with per-exec capture pipes without reading the deadlock argument in
  `docs/AUDIT.md`.
- **The system prompt is pi's, and the extension only fills pi's slots.** Behaviour → the tool and
  parameter descriptions; guidance → each tool's `promptGuidelines`; the one session-dynamic fact (which
  channels an earlier process left) → bullets appended to `options.promptGuidelines` in
  `before_agent_start`. Never `options.sections[...]`: pi wraps those in a tag of their own name and keeps
  them when the user overrides the prompt. `event.systemPromptOptions.customPrompt` is set by `SYSTEM.md`
  (agent dir or `.pi/` in the project) and by `--system-prompt`, and pi then renders no `preamble` of its
  own, no `tools` section and no `rules` — so snippets and guidelines are already out, and the handler
  returns without touching anything. The extension's contract still reaches the model, because an active
  tool is declared with its description and parameters whatever the prompt says. `bash
  scripts/smoke-prompt-surface.sh` reads the rendered sections out of the session file and checks all of
  it against real pi. Do not put Python idioms (`open(path).read()`, `subprocess.run`) in a description
  either: they teach a model nothing it does not already know, and they shift its preferences.
- **A channel name is three file names** — the daemon log, the history file, the IPython profile — and
  they must come from `names.ts`, the one place that keeps the mapping one-to-one. Naive sanitising puts
  `a/b` and `a_b` in one log, one history file and one sqlite profile; keying the "these channels are
  gone" note by the *file stem* instead of the record's real name tells the model a running channel
  died (R2-04). Two holes to keep in mind while it is verbatim-or-digest: the stem this function produces
  is itself a legal name, so a name that already looks digested (`-<10 hex>`) must never be kept verbatim
  or the mapping has fixed points (R3-03) — which also means `channelFileStem` is *not* idempotent and
  nothing may feed a stem back into it; and the name travels as a daemon argument, where a leading `-`
  reads as an option, so it is passed as one token, `--channel=<name>` (R3-02). `run` also refuses names
  over 200 characters, because a channel name is quoted in results, in the history file and in every later
  session's prompt guidelines (F3-02).
- **Anything the host pastes into an answer is part of the size of the answer.** The 50 000 budget covers
  the capture and the traceback, and most of what is left is text a *cell* (or a caller) chooses: the
  daemon's `log` frames, reachable from a cell via a `signal` handler's `__name__`; the names a cell bound,
  which land in the result, in the history file, and in the prompt guidelines of every later session; an
  exception's `__name__`, bounded only by what `type()` accepts; and the channel name itself. Bound every
  one of them where it is quoted (`oneLine`, with the limits as constants in `manager.ts`/`prompt.ts`, and
  the note ring clipped in `Channel.note` so the host never holds the whole string). `details.definitions`
  is deliberately the raw list.
- **The 50 000-character limit covers the cell's text — the capture *and* the traceback — not the notes
  around them.** The traceback arrives in the `exec_end` frame and is appended after the capture, so it
  needs its own share of the budget or a cell that raises with a row of data in its message returns a
  result of unbounded size (R2-02). If you shorten anything, put the full text in the exec log and bind
  the nonce global — that is the deal every shortening here makes. What is *not* inside that budget is
  the text the host adds around the cut: the `[new channel: …]` banner, the truncation notes and their
  log pointer, the death notes, the daemon's last lines. They add a couple of kilobytes, which is why
  every `limits.test.ts` assertion allows `MAX_OUTPUT_CHARS + 5_000` — and why no document may promise a
  whole answer inside the limit (R4-08).
- **A cancelled call never sends its cell.** `run` threads its `AbortSignal` into the channel creation:
  a call aborted while its daemon is still coming up closes that half-started daemon (the same teardown
  a failed start does, and `Channel.close` is one-shot per channel), releases the slot it was holding,
  and answers "aborted" without putting the cell on the wire; a call aborted while it queued behind
  another call on the same channel sends nothing either (R4-06), and neither does a queued call whose
  channel went while it waited — `runLocked` checks `channel.closed` before `begin` can throw a death
  note and have the answer be a plain "the Python process behind channel X ended", which would never say
  the cell was never sent (F6-01). That check comes **before** the abort check, because the abort sentence
  claims "the channel kept its state" and that is false for a channel that died while the call waited.
  This is consistent with the interrupt rule — an abort detaches or interrupts, it never kills a running
  cell — and it is what makes Esc the only way out of a wedged start.
- **A quit closes daemons that never finished starting.** `starting` holds promises, and nothing can close
  a promise, so `startChannel` hands the manager the daemon the instant it spawns (`halfStarted`) and
  `quit()` closes those as well as the live channels. `createChannel` also compares a **quit epoch**: a
  start that began before a quit and finishes during it is closed rather than adopted, because the map it
  would be adopted into is one the quit has just cleared. The epoch, not a flag — the manager outlives
  sessions, so a flag would poison the next one (F4-01).
- **A call that *joins* somebody else's channel creation owns nothing** — not the daemon, not the
  `starting` slot, not the cap. That is what R5-01's `untilAborted(…, joined = true)` and
  `ChannelJoinAbortedError` are for: the joiner's cancel ends its own wait and nothing else, and its
  answer must not claim it freed a slot it never held. It owns no **session** either: a `quit()` marks
  every creation in flight as `doomed`, and `getChannel` refuses to hand such a creation to a joiner
  (`ChannelStartDoomedError`) rather than answer a live session with the ended session's sentence, or
  leave its name blocked behind a start that cannot succeed (R6-01). Two things to keep straight before
  touching this: never "fix" it by clearing `starting` from `quit()` — the creation is still running and
  would install its daemon into the map the new session owns; and do not make the joiner start its own
  creation instead of refusing, because that puts two daemons under one name in one process (one daemon
  log, one history file, one IPython profile) for as long as the doomed one takes to die — pass 5 measured
  4.5 s for a daemon that ignores `shutdown` and SIGTERM. Reachability in a test is narrower than it looks:
  `quit()` awaits the close of every daemon it can see, so a doomed creation whose daemon had already
  spawned is dead, and its slot released, before the next session gets to ask. The window is a creation
  with **no daemon yet** — the env-lock recipe (`PI_REPLMODE_ENV_DIR` at a dir with `bin/python`, no
  `.complete`, and a `<envDir>.lock` directory) is how both lifecycle tests hold it.
- **A status field is a claim about the thing the answer names, not about the call.** `details.status` /
  `structuredContent.status` say `"dead"` when a *channel* is gone. A call that never sent anything and
  left its channel alive — a cancelled joiner, a call cancelled while it queued, `bg_stop` for an id this
  process never heard of — must not borrow that status or that channel (R6-02, R6-03). `bg_stop` and
  `bg_wait` have no channel of their own to fall back on: an error that is about a channel carries it
  (`ChannelNamedError`), and `failure()` leaves the field out when the answer is about none.
- **A channel is only a channel while its process is.** `channel.closed` turns true when node is *told*
  about a death, which can lag the death itself, so `getChannel` asks `processGone` (a zombie counts as
  gone) before handing a caller a channel, and the settled-task branch of `bg_stop` asks the same question
  before implying a channel is alive (F4-02, R4-04).
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
  `channels.set` / `starting.delete` handoff has to keep the union of the two maps correct — which is
  also why an aborted start is cancelled *inside* `createChannel`/`startChannel` rather than by racing
  `getChannel` from outside: a creation that is still running in the background would otherwise install
  its daemon in `channels` after the call that spawned it gave up (R4-06).
- **A test file must not import from `src/` at the top of the file.** `loadExtension` points
  `PI_CODING_AGENT_DIR` at a temp dir *before* it imports the extension, and `src/paths.ts` fixes
  `EXEC_LOG_DIR`, `HISTORY_DIR` and the rest at import time — so a static `import { x } from "../src/…"`
  evaluates those paths while the environment still names the user's real agent dir, and the extension
  can end up running the whole file against `~/.pi/agent/replmode/`. Import the module under test inside
  a test (`await import("../src/manager.ts")`), or use `vi.resetModules()` plus a second
  `loadExtension({agentDir})` the way `names.test.ts` does. That file's top-level `getManager()` works
  only because the manager is a `globalThis` singleton built by the extension's own correctly-pathed
  module instance; do not copy that shape for anything that reads a path.
- **vitest timing**: `bg_wait` returns when *any* task finishes, so assertions about elapsed time
  must be relative to when each task was started, not to the cell's own length. Anything that waits on
  real signal delivery is timing-sensitive; prefer `waitFor` over fixed sleeps, and never assert on
  *where* a racy interrupt landed (a SIGINT left pending across an exec boundary may be reported as the
  cell or as the loop, and both are correct). A full-suite run is loaded enough that node can trail a
  child's death by more than one poll interval: `bg_stop` on a task whose channel died an instant earlier
  was flaky for exactly that reason, which is why `bgStop` asks `processGone` rather than trusting
  `channel.closed` alone. The same trap in the other direction: a stub daemon announces itself by writing a
  pid file, and `waitFor(() => existsSync(pidFile))` can sample it in the gap between `open()` creating it
  and the pid being written into it — an empty read then looks like a dead daemon. Poll for the parsed
  number instead, so a wait ends only on a pid that was actually reported.
- **Temp litter**: a full vitest run leaves a few dozen `/tmp/replmode-agent-*` and `/tmp/replmode-cwd-*`
  directories behind (a few MB in total) — `loadExtension` removes the agent dir it created itself, but
  `names.test.ts` shares one across its tests via `makeTempDir` and no file removes that one, and the cwd
  dirs are never removed. Nothing depends on them; `rm -rf /tmp/replmode-*` between runs if it bothers you.
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
