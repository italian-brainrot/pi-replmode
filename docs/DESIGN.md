# pi-replmode — design

Status: **M1 and M2 built; M3 (rich display and the `call` round trip) not started.** `AGENTS.md` is
the spec written by the user; this file is the implementation plan derived from it, plus the parts the
spec leaves open. The decisions the spec left open are settled in
[Decisions](#decisions-the-spec-left-open) — do not re-litigate them, and keep the two in sync if
either changes. [AUDIT.md](AUDIT.md) records the tester↔fixer passes over the built parts and what each
one changed; several paragraphs below exist because an audit found the code and this file disagreeing.

## What it is

A Pi extension that gives the model one stateful Python (IPython) REPL instead of a pile of
one-shot tools. The model runs code, keeps variables alive between calls, and defines its own tools
as Python functions.

Contrast with pi's built-in `codemode`: codemode is a **stateless** QuickJS sandbox whose job is to
call pi's other tools and filter their output. replmode is a **long-lived Python process** whose job
is to hold state — dataframes, model weights, connections, parsed trees, functions the model wrote —
across the whole session.

## Non-goals

- No integration with other extensions' tools or MCP servers (per `AGENTS.md`). Nested model calls
  go through `run_subagent`, which spawns a nested `pi`.
- No JS/TS sandbox, no REPL for pi's own tool layer.
- Not a Jupyter frontend. We speak our own protocol, not ZMQ/ipykernel.

## Process model

```
pi process (Node 22)                                   one Python process per channel
┌────────────────────────────┐        stdin (fd 0)     ┌──────────────────────────────┐
│ extension: ReplManager     │ ── JSON lines ────────▶ │ daemon: IPython InteractiveShell │
│  channels: Map<name,Chan>  │ ◀─ JSON lines ───────── │  asyncio loop, single thread  │
│  tasks: Map<id,Task>       │        stdout (fd 1)    │  user globals live here       │
└────────────────────────────┘                         └──────────────────────────────┘
           ▲                                            stderr (fd 2) = captured user
           │                                              stdout+stderr, raw bytes, sentinels
        ctx.ui / ctx.sessionManager / nested pi
```

- **One daemon process per channel.** `channel` is an isolated REPL instance; the model picks the
  name, we create it on first use. Separate processes give real isolation, per-channel interrupt,
  and per-channel kill — a segfault in one channel cannot take the others down.
- **Single-threaded daemon**, IPython on the main thread inside a raw asyncio loop, never
  `asyncio.run()`. This is what makes SIGINT-based interrupt work (see "Validated facts"), and it has
  two halves: a cell that is *running bytecode* takes the `KeyboardInterrupt` CPython raises there, and
  a cell that is *parked on an `await`* has to be handed the interrupt by the daemon, because the signal
  is raised in the thread driving the loop and would otherwise be caught and dropped there. Each cell
  runs as a task the `Runner` holds; `Runner.interrupt_cell` puts a `KeyboardInterrupt` on the future
  that task is waiting for — which raises it inside the cell, where IPython reports it properly — and
  escalates to cancelling the task when that is not possible. A second interrupt always gets through.
  At every exec boundary the signal **mask** is unblocked rather than restored to what it was, and the
  SIGINT **disposition** is put back to what the daemon started with, so one cell that installs
  `SIG_IGN` or its own handler cannot disarm the channel for every later cell.
- Idle daemons are cheap (≈43 MB RSS, 60 ms to import IPython), but they are not free: cap the
  number of live channels (default 4, env override), LRU-shutdown the idlest when at the cap, and
  shut all of them down at `session_shutdown`. A channel whose daemon is still starting occupies a slot
  too — `run` is registered parallel and the prompt recommends separate channels for independent work,
  so counting only daemons that have already answered would let one tick of five calls start five.

## Wire protocol

Line-delimited JSON on stdin/stdout. stderr is *not* protocol: the daemon's first act is
`proto = dup(1); dup2(2, 1); dup2(2, 2); capture = dup(2)`, so protocol frames go only to the saved fd
and every byte the user's code writes to fd 1 or 2 — Python `print`, IPython's `Out[n]:`, subprocesses,
C libraries — lands in the capture pipe. `capture` is the daemon's own reference to that pipe: fd 1 and
fd 2 belong to the cell, which can close or redirect them, and the daemon neither loses its boundary
markers nor lets one cell's vandalism blind the channel. The daemon's own diagnostics go to a log file
and to `log` frames, never to those fds. `PYTHONUNBUFFERED=1`.

Host → daemon:

| frame | fields | meaning |
| --- | --- | --- |
| `execute` | `id`, `code` | run a cell |
| `interrupt` | – | `os.kill(pid, SIGINT)` equivalent; aborts the running cell only |
| `setvar` | `name`, `path` or `text` | bind text (or the contents of `path`) to a global — the truncation escape hatch, where the host hands over the log file rather than its contents |
| `call_reply` | `id`, `ok`, `value` / `error` | answer to a daemon-initiated call *(M3: nothing sends `call` yet)* |
| `shutdown` | – | exit cleanly |

Daemon → host:

| frame | fields | meaning |
| --- | --- | --- |
| `ready` | `channel`, `pid`, `ppid`, `cwd`, `python`, `ipython`, `startup_ms`, `log` | daemon up, channel usable |
| `output` | *(out of band — the capture pipe, not JSON)* | |
| `exec_end` | `id`, `ok`, `status` (`ok`\|`error`\|`interrupted`), `elapsed`, `ename?`, `evalue?`, `traceback?`, `definitions?` | cell finished. The repr of the last expression is already in the capture, so it is not repeated here; `definitions` names what the cell bound |
| `display` | `id`, `mimes` (`image/png`, `text/plain`, …) | an image/rich object reached the model *(M3: recognised and ignored)* |
| `call` | `id`, `kind` (`ask`\|`subagent`\|`notify`), `args` | daemon asks the host to do something; blocks the cell until `call_reply` *(M3)* |
| `log` | `level`, `text` | daemon diagnostics (also mirrored to the log file) |
| `fatal` | `error`, `traceback?` | the daemon cannot continue; the channel is over |

Exec boundaries in the capture pipe are marked with a sentinel
(`b"\x00\x1ePIRB\x1e<exec-id>\n"`), so the host knows where one cell's output ends, where a
`display` frame's text split goes, and can strip the sentinels when writing log files. A false
positive needs a program to write that exact byte sequence to a text stream; the splitter hands the
marker bytes to the boundary callback, and a marker whose id is not one of the channel's execs goes
back into the byte stream as data — it neither opens nor closes a block, and the cell's output carries
on where it left off.

**What attribution guarantees, precisely** (audit pass 2, R2-07 — every channel's processes share one
capture stream, so this is the honest boundary, not an implementation detail):

- bytes that arrive **while no block is open** go to the log of the exec whose block closed last, under
  a header that says whose log it is ("arrived after this cell ended: from something the channel left
  running, not from a cell"), capped at 256 KB per exec;
- output from before the first cell ever ran is attached to the first block, capped at 64 KB;
- seeing such out-of-band bytes flags the channel, and every later result from it says the channel has
  produced output no cell asked for, so some of its lines may not be from this cell;
- bytes that arrive **while a block is open** are *not* attributable — at the descriptor level they are
  indistinguishable from the running cell's own output, and nothing claims otherwise.

A per-exec capture pipe would make the last case exact, and was rejected: the host cannot read a
pipe the daemon made, and a daemon-side pump stalls (a cell that blocks in C stops the loop, the
64 KB pipe fills, the cell blocks on write). See [AUDIT.md](AUDIT.md) "Pass 2 fixes".

Sync `pi.*` calls from the cell write a `call` frame and then **pump stdin directly** (select +
read frames) until their own `call_reply` arrives. Only one cell runs per channel at a time, so the
pump is trivial, and it stays interruptible: the SIGINT handler still raises `KeyboardInterrupt`
out of the wait.

## The `run` tool

```
run(code, timeout = 60, channel = "main")
```

- Registered tools: `run`, `bg_wait`, `bg_stop` and nothing else. The extension **never** calls
  `setActiveTools()` and never registers anything under a built-in name — displacement is the user's
  pi config, not our business (see [Decisions](#decisions-the-spec-left-open)).
- `executionMode: "parallel"` — different channels genuinely overlap; same-channel calls are
  serialized by a per-channel mutex in the manager.
- Foreground: result text = capture of that exec (host-side, between sentinels). Truncation at
  50 000 chars keeps head+tail, writes the full text to
  `<agent-dir>/replmode/exec/<exec-id>.log`, **and** asks the daemon to bind the full text to a
  nonce global (`_out_7f3a2b`) so the next cell can slice it.
- Error result: cell raised → `isError: true`, the traceback (IPython `colors="NoColor"`) goes in
  `content`, partial output stays visible before it. The 50 000-character limit covers the **whole
  answer**: the traceback arrives in the frame, not the capture, so it is given whatever the capture did
  not need (never less than a quarter of the limit) rather than riding on top of it, and when it is
  shortened the whole thing is appended to the exec log and the same log-plus-global escape hatch
  applies. The exception's own `evalue` is clipped to one line, because the traceback already carries it.
- `timeout` expiry does **not** kill anything: the host detaches, returns
  `moved to background with ID: repl-<id>` plus the log path and the last ~4 KB, and keeps draining
  the capture pipe into that log. The `exec_end` frame arrives later and completes the task record.
- A `run` on a channel whose previous cell is still in the background fails with
  `channel "main" is busy: repl-… is still running (bg_wait to wait, bg_stop to stop)`.
- `bg_wait` / `bg_stop` follow pi-bg-tasks: ids, statuses (`running`, `completed`, `failed`,
  `killed`), runtime, line/char counts, log path, session-scoped listing. `bg_stop` sends
  KeyboardInterrupt (SIGINT) — the spec is explicit, and it is the only stop that preserves the
  channel's state. A task that ignores SIGINT stays `running`; `bg_stop` on it again reports that the
  daemon is unresponsive and that the only remaining option is to kill the channel (`kill: true`, or
  a documented `bg_stop` escalation), which loses that channel's variables. We do not kill silently.
- Escape/abort during a foreground call → send `interrupt` first (the cell dies, state survives),
  and only escalate if the daemon ignores it.
- **Closing a channel always takes the process group down** (`SIGTERM`, then `SIGKILL`). The daemon
  answers `shutdown` and goes promptly; its cells' children do not, and a dev server or training loop
  still running after "the channel was taken down" is a bug, not a loophole. This covers `kill: true`,
  the LRU eviction at the channel cap, a daemon that never became ready, and `session_shutdown` with
  `reason: "quit"`. One exception, stated wherever the promise is made: a child that left the process
  group (`start_new_session=True`, `setsid`, a double fork) is outside `kill(-pid)`'s reach and survives
  the channel. Closing the hole means walking a process tree, which is worse than the hole
  (audit pass 2, R2-09; pinned by a test that asserts the escape).

`details` carries the structured shape (`channel`, `exec_id`, `status`, `elapsed`, `truncated`,
`log_path`, `images`, `definitions` added by the cell) so `renderCall`/`renderResult` and resumed
sessions have something to work with; `outputSchema` + `structuredContent` mirror pi-bg-tasks. pi does
not validate `structuredContent` against `outputSchema`, so the schema has to be written against the
answers the tool actually gives: `output`, `truncated` and `elapsed_seconds` are optional because a call
that never reached a daemon — busy channel, empty code, invalid timeout, backgrounded start — genuinely
has none, and every `status` in a result comes from the declared enum (R2-05).

## Rich display

Host preference order, per the spec: `text/plain` (i.e. `repr`) for text, images as visual content,
everything else (`_repr_html_`, `_repr_javascript_`, …) ignored rather than dumped as source.

Implementation: a `DisplayFormatter.format(obj, include=("text/plain", "image/png", "image/jpeg"))`
call in a custom display hook and display publisher — PNG/JPEG formatters are **not** enabled
globally (that would make every `_repr_html_` and every matplotlib figure pay for a rasterization
we may not want); they are asked for by name. `image/svg+xml` becomes text unless a rasterizer is
available. matplotlib gets the `matplotlib-inline` backend (already an IPython dependency) so
figures arrive as PNG.

Content assembly: each `display` frame splits the model-facing `content` array at the sentinel,
which gives exactly the shape the spec describes for `read_image` — `[text, image, text]` for one
call, `[text, image, text, image, text]` for several, empty text blocks merged. Cap images per exec
(10) and per image (8 MB base64) with an explicit note instead of silent drops.

## The `pi` namespace (pre-imported in the REPL)

| name | behavior |
| --- | --- |
| `pi.read_image(image, max_size=2000)` | accepts path / ndarray / PIL; normalizes HWC/CHW/HW, float (0,1) with clamping warning; resizes; emits a `display` frame |
| `pi.ask(question, choices=())` | `call` frame → host → `ctx.ui.select`, and a manual answer choice is **always** appended; returns `str`; errors clearly when `ctx.hasUI` is false |
| `pi.run_subagent(prompt)` | `call` frame → host spawns `pi --mode json -p --no-session --model <current>`, returns final text, adds the nested usage to the tool result's `usage`, reuses pi-subagent's `PI_SUBAGENT_DEPTH`/`MAX_DEPTH` nesting guard |
| `pi.channel` / `pi.cwd` / `pi.session` | read-only context values, so code can report where it is |

**No filesystem or shell helpers.** The env is bare Python + IPython (`subprocess`, `pathlib`,
`!cmd`); a model that wants a reusable tool defines a function, which is the whole point.

Injected, as safety rather than convenience: `input()` raises with a pointer to `pi.ask` (unclaimed
stdin is the protocol), `exit`/`quit` are neutralized (SystemExit from a cell is a failed cell, not
a dead channel).

## Lifecycle

- Daemons start lazily on the first `run` of a channel; startup cost is ~100 ms, and the first
  response reports the Python/IPython versions and cwd.
- **Reload / session replacement**: keep the manager on `globalThis.__piReplmode__` so a `/reload`
  re-adopts the live daemons and their pipes instead of orphaning them (pi's extension cache is
  cleared on reload, but `globalThis` survives — the mechanism pi-bg-tasks needs sidecar files for).
- **Restart**: state is gone, by design. Write a per-channel history
  (`<agent-dir>/replmode/history/<encoded-channel>.jsonl`: code, timestamp, status) so a fresh session can
  see what the lost channel held, and post a chat notification at `session_start` when history
  exists for a channel that has no live daemon, per the spec. The channel name is used as three file
  names — history, daemon log, IPython profile — so they all come from one function (`names.ts`): a name
  that is already a file name keeps it, anything else gets a short digest of the real name appended, and
  `a/b` and `a_b` no longer share a file (R2-04). The note is keyed by the *real* name the record
  carries, never by the file stem, or a running channel gets announced as one that was lost.
- Daemon death (user code segfaults, `os._exit`, OOM) → protocol EOF → mark channel dead, fail the
  in-flight call with what was captured, recreate on next use. EOF on the frame stream counts as death
  even if the process is still there: a daemon that closed its own protocol descriptor can never answer
  again, and the daemon now notices that itself (`send_frame` → `ProtocolGone`) and exits non-zero, so
  the host's death path reports the truth instead of timing out. An `exec_end` that arrived before the
  death does not make the call a success.
- A channel that **never started** says why: the failure handed to `run` composes the exit reason, the
  daemon's `fatal` frame and whatever the interpreter wrote to the capture stream before it died (read
  before that buffer is emptied, and after the pipes have had a bounded moment to drain, since `exit` can
  beat the last of stderr), cut to a few KB with a pointer to the daemon's log file (R2-06). A capacity
  refusal is a separate case: it is not a start failure, and is reported as one of the cap.

## Prompt surface

Short `promptSnippet` + a few `promptGuidelines` on the tool, plus one `before_agent_start` section
(`replmode`) that explains statefulness, channels, the `pi` namespace, and the timeout/background
contract — same mechanism pi-takeover uses for `<takeover>`. Kept to ~15 lines: the model is
expected to be fluent in Python already.

## Python environment

- **Auto-created, outside the project folder, and disposable.** `requirements.txt` lives in the repo
  as the source of truth; the venv does not. Default location
  `${XDG_CACHE_HOME:-~/.cache}/pi-replmode/py-env-<hash>` (`PI_REPLMODE_ENV_DIR` overrides), where
  `<hash>` covers the interpreter and the pinned requirements, so a changed pin or a new Python gets
  a fresh env instead of a broken one, and a wiped cache costs a re-sync and nothing else.
- Creation is lazy and single-flight: the first `run` that needs a channel builds it with
  `uv venv` + `uv pip install -r requirements.txt` (uv is already on this machine; fall back to
  `python -m venv` + pip and say so), and the tool result says what it did. No `uv` and no usable
  interpreter → the tool fails with the exact command to fix it, never a silent system-python install.
- Nothing is ever installed into the project folder, the repo, or the user's system Python.
- Pinned deps: `ipython`, `pillow`, `numpy` are the base daemon. The rest of the spec's list
  (`pandas`, `polars`, `scipy`, `matplotlib`, `httpx`, `requests`, `pyyaml`, `scikit-learn`,
  `librosa`, `opencv-python-headless`, `playwright`) goes in the same pinned file — installed once,
  never imported by the daemon at startup, so a heavy set costs disk and sync time, not latency.

## Testing & tooling

Both suites drive **real processes**; there is no fake daemon. A channel daemon starts in about
10 ms, and the interesting failures live in the pipes, the signal handling and the exit path, which
a scripted fake would paper over.

- **pytest** (`python/tests/test_daemon.py`, `npm run py:test`) spawns the daemon and speaks the
  protocol to it: state, magics, top-level await, subprocess capture, sentinel framing, tracebacks,
  syntax errors, interrupts mid-cell and while idle, the signal-mask restore, `setvar`, guards,
  large output, unicode, malformed frames, death.
- **vitest** (`test/`, `npm test`) loads `src/index.ts` through a recording `ExtensionAPI` harness
  (`test/helpers/extension.ts` — any new `pi.*` dependency the extension takes has to be added
  there, so tests keep covering the real path) and then runs real daemons: capture attribution,
  truncation and the nonce global, busy channels, `bg_wait`/`bg_stop`, daemon death and
  recreation, reload re-adoption, the channel cap, the environment build, the prompt surface.
- **Stub interpreters** (`test/lifecycle.test.ts`) cover the paths a real daemon never takes: never
  becoming ready, answering a cell and then dying, closing its own protocol stream. Point
  `PI_REPLMODE_ENV_DIR` at a directory whose `bin/python` is a script and the host talks to it over
  real pipes with no change to `src/`. It is a fake *peer*, never a fake *host*.
- **`npm run dev`** watches `src/`, `test/` and `python/` and re-runs the suite the change belongs
  to; `npm run dev -- --all` is the whole gate (typecheck, biome, vitest, pytest) and is what CI
  runs (`.github/workflows/ci.yml`).
- Operational notes, debugging tricks and a real-`pi` smoke recipe: [DEV.md](DEV.md).

## Validated facts (from the `/tmp` spikes, not assumed)

- IPython 9.18 installs and runs on the local Python 3.14.9; `import IPython` +
  `InteractiveShell.instance()` ≈ 0.06 s, RSS ≈ 43 MB before numpy.
- `run_cell_async(code, transformed_cell=shell.transform_cell(code), store_history=True)` is the
  required call shape in IPython 9 — passing a raw cell raises `TypeError`.
- Top-level `await`, `!cmd`, and `%magic` all work headlessly; state persists across cells;
  `_`/`_oh` work.
- **Do not use `asyncio.run()` in the daemon.** Its runner installs a SIGINT handler that cannot
  reach a coroutine stuck in synchronous code — the spike hung forever. A raw
  `new_event_loop()`/`run_until_complete` leaves CPython's default handler in place, SIGINT raises
  `KeyboardInterrupt` inside the executing cell, IPython reports it, and the shell recovers for the
  next cell. This is the whole interrupt design.
- **`asyncio.Task` has no `throw()`.** An interrupt for a cell parked on an `await` has to be put on
  the future the task is waiting for: `await coro` yields its leaf future up to the task, so
  `task._fut_waiter` is usually exactly the object the cell is sleeping on, and
  `set_exception(KeyboardInterrupt())` raises inside the cell where IPython formats it properly
  (verified for `sleep`, `to_thread`, `gather`, `Event.wait`, `Queue.get`, and
  `create_subprocess_exec(...).wait()`). `task.cancel()` is the fallback, and then the cell genuinely
  sees `CancelledError` — reported as interrupted, logged as such, not dressed up.
- **A cell can wreck the daemon's own file descriptors** (`os.close(3)` is the saved protocol fd;
  `os.closerange(3, 4096)` takes everything). Holding a private `dup` of the capture pipe is what keeps
  the *capture* honest; nothing can keep the *protocol* honest, so the daemon notices the write failing
  and exits rather than sitting on a channel that can never answer again.
- fd-level capture works and catches subprocess output; IPython's own `Out[n]:` and tracebacks flow
  through it in the right order. `colors="NoColor"` removes ANSI from tracebacks.
- `display_formatter.format(obj, include=(...))` returns `(data, meta)` with `image/png` base64 for
  objects exposing `_repr_png_`, without enabling those formatters globally.
- pi's tool contract allows image content directly: `AgentToolResult.content` is
  `(TextContent | ImageContent)[]`.
- pi 1.4.0 activates extension tools on registration while built-ins follow the `defaultTools`
  setting, so `"defaultTools": []` (or `--no-builtin-tools`) is a complete replacement and the
  extension never has to touch the active tool set. Verified with a real `pi --no-builtin-tools`
  session, not just by reading `settings-manager.js`.
- `structuredContent` is not validated against `outputSchema` at runtime in pi 1.4.0; the schema is
  descriptive (it matters for a model that writes a wrapper around the tool).
- `/reload` clears pi's extension module cache but keeps the Node process and its child pipes: a
  manager rebuilt from the module would orphan running daemons, hence the `globalThis` singleton.

## Milestones

1. **M1 — core**: done. Daemon, protocol with sentinels, fd-level capture, `run` end to end,
   truncation with log + nonce global, tracebacks, both test suites.
2. **M2 — concurrency**: done. Timeout → background (never a kill), `bg_wait`, `bg_stop`
   (SIGINT, escalation to a channel kill only when asked), channels with a per-channel mutex, the
   process cap, busy-channel errors, reload re-adoption, per-channel history and the restart
   notification.
2b. **Hardening (audit passes 1 and 2)**: done. Every issue the first two tester↔fixer passes found is
   fixed and pinned by a test — interrupt delivery into waiting cells, signal-disposition hygiene, the
   frame loop surviving anything, capture attribution under vandalism, group-kill on close, honest totals
   in truncation notes, the tail of a windowed log, the channel cap under a parallel burst, channel-name
   collisions, the output limit covering the traceback too, and what a failed channel start reports. See
   [AUDIT.md](AUDIT.md) before changing any of it; a third pass is expected to attack these fixes.
3. **M3 — round trips**: not started. The `display` frame is recognised and ignored, and the `call`
   pump is absent. What it needs: formatter selection with `include=(...)` per object (spike
   proves the call shape), `display` → image content in the `run` result, `pi.read_image`, sync
   `pi.ask` and `pi.run_subagent` over the stdin pump, and the `call`/`call_reply` pump in the
   daemon. `pi.ask` from Python alone is the piece most likely to fight the interrupt design, so
   start with `read_image`, which has no round trip.
4. **M4 — packaging & polish**: mostly done (env strategy, prompt section, README, CI, the
   displacement question settled). Left: TUI renderers for a backgrounded cell, and flipping this
   repo over to dogfooding itself.

## Decisions the spec left open

Settled with the user; implement these, do not re-open them.

1. **Displacement is config, not code.** The extension registers only `run`, `bg_wait`, `bg_stop`
   and never touches the active tool set. The user reaches full replacement with
   `"defaultTools": []` in settings (`--no-builtin-tools` for one run), which drops every built-in
   while leaving extension tools active. README carries that snippet.
2. **Env auto-creates itself in a disposable cache dir**, never in the project folder
   (see [Python environment](#python-environment)).
3. **Bare Python.** No `pi.sh` / `pi.read` / `pi.write`; the model writes its own functions.
4. **`pi.ask` is sync** (returns `str`, implemented with the stdin pump, still interruptible) and
   always offers a manual answer choice.
5. **Capture attribution stops at what the two pipes can see** (pass 2, R2-07). No per-exec capture
   pipes: a daemon-side pump deadlocks against a cell that blocks in C, and the host cannot read a pipe
   the daemon created. Between blocks attribute, flag the channel, say so in the result; during a block,
   nothing is claimed. Reopen only with a cheap signal, never with a pump.
6. **One encoder for every file name a channel name becomes** (`names.ts`). Not a constrained name
   language — the model may name a channel `notes/live` — and not naive sanitisation, which collides.
   A digest suffix appears only for names that are not already file names.

## Where the next session starts

M3, in the order above: `read_image` and the display pipeline first, then the `call` pump for
`pi.ask` and `pi.run_subagent`. The parts everything else stands on — daemon, protocol, capture,
interrupt semantics — are built, audited once, and covered by real-process tests, so the risk in M3 is
concentrated in the display formatters and in a synchronous round trip that stays interruptible. Note
for the `call` pump: it pumps stdin inside a cell, which is exactly where the interrupt design gets
tested again — the pump must stay interruptible the same way `Runner.interrupt_cell` does, and
`Inbox` was built on the loop's reader precisely so its buffer can be drained synchronously.

`README.md`, `AGENTS.md` and this file are the three things to keep honest; `docs/DEV.md` carries the
operational detail. The spikes in `spikes/` are worth re-running before touching formatters: they
are the evidence for `include=(...)` selection and for the interrupt design.
