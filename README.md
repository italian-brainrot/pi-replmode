# pi-replmode

A pi extension that replaces the one-shot tool pile with **one stateful IPython REPL**. The model
reads files, edits files, runs commands and does real computation through a single `run` tool whose
process keeps living between calls — so it can define a Python function once and keep calling it,
hold a dataframe across ten calls, and watch a long job through a log file.

Registers exactly three tools: `run`, `bg_wait`, `bg_stop`. It never touches pi's active tool set;
how much of pi's built-in `read`/`bash`/`edit`/`write` you drop is your config.

## Install

```bash
pi install /home/qq/distrobox/ubuntu/Projects/pi-replmode
```

or in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/home/qq/distrobox/ubuntu/Projects/pi-replmode"]
}
```

The extension then adds `run`, `bg_wait` and `bg_stop` to every session, alongside pi's built-ins.

### Full replacement

To run pi with *only* these tools, set the default tool list empty — extension tools are activated
on registration, built-ins follow `defaultTools`:

```json
{
  "defaultTools": []
}
```

For a single run:

```bash
pi --no-builtin-tools
```

Or keep some built-ins and drop others: `"defaultTools": ["read", "edit"]`.

## Tools

| tool | what it does |
| --- | --- |
| `run` | send a cell to the REPL. Args: `code`, `channel` (default `main`), `timeout` in seconds (default 60, `0` starts in the background). |
| `bg_wait` | wait for any background task to finish, then list every task of the session with its status, runtime, output size and log path. Args: `timeout` (default 600). |
| `bg_stop` | interrupt one background task with SIGINT, which ends the cell and **keeps** the channel's variables. Args: `task_id`, `reason`, `kill: true` to take the whole channel down. |

A cell is standard IPython input: magics, `!command`, `?`, top-level `await`, and a trailing
expression whose `repr` is shown.

### Channels

`channel` picks an isolated REPL — its own variables and its own Python process. Channels run
concurrently, which is how two long jobs overlap. A channel with a cell in the background refuses
new work until that cell finishes (the error names the task and what to do about it). At most
`PI_REPLMODE_MAX_CHANNELS` (default 4) live channels per pi process; the idlest is shut down to make
room, and its variables go with it.

### Timeouts are not kills

A cell that passes its `timeout` keeps running: you get a task ID and a log path, and the channel is
busy until it finishes. Aborting the call (Esc) sends one SIGINT — the cell ends as interrupted and
the channel keeps everything. Only `bg_stop { kill: true }` destroys a channel, and it takes down the
process group with it: a dev server, a build or a training loop the cell started goes with the channel
rather than being left behind holding a port. A child that moved into a process group of its own
(`start_new_session=True`, `setsid`, a double fork) is outside that kill's reach and does survive.

A cell that stops a signal, or sits in something CPython cannot interrupt (`os.system`, a C extension
holding the GIL), will not stop for SIGINT. `bg_stop` says so rather than killing anything; `kill: true`
is then the only way out, and it costs the channel's variables.

### Output over 50 000 characters

The limit covers the whole answer, the traceback included. The middle is cut, head and tail kept, and
nothing is simply dropped: the whole output is written to a per-cell log file, and the same log is
bound to a global named `_out_a91f0c` in that channel, so the next cell can slice it without
re-running anything.

## Python environment

The first `run` creates a Python environment; you do not have to set anything up.

- `uv` if present (fast, cached), otherwise `python -m venv`.
- Pinned by [`requirements.txt`](requirements.txt): IPython, numpy, pandas, polars, scipy,
  scikit-learn, matplotlib, opencv, librosa, Pillow, httpx, requests, pyyaml, playwright.
- Lives in a disposable cache dir named after the interpreter and the pins:
  `~/.cache/pi-replmode/py-env-<hash>`. Never in the project folder, never in your system Python.
  Wiping it costs a reinstall and nothing else.
- Rebuild automatically when `requirements.txt` or the interpreter changes.

| variable | meaning |
| --- | --- |
| `PI_REPLMODE_ENV_DIR` | put the environment somewhere else |
| `PI_REPLMODE_REQUIREMENTS` | build it from a different pin file (gets its own environment directory) |
| `PI_REPLMODE_PYTHON` | which interpreter to build it from |
| `PI_REPLMODE_MAX_CHANNELS` | live channels per pi process (default 4) |
| `PI_REPLMODE_KEEP_RUNNING` | `0` shuts the channels down on every session boundary, not only on quit |
| `PI_REPLMODE_READY_TIMEOUT_MS` | how long a daemon may take to report ready (default 120 000) |

## Logs

Everything a cell printed goes to a log file, whether or not it fit in the tool result:

```
~/.pi/agent/replmode/
  exec/<exec-id>.log     full capture of one cell (stdout, stderr, subprocesses)
  daemon/<channel>.log   the daemon's own diagnostics
  history/<channel>.jsonl  one line per cell, so a new session can see what a lost channel held
```

A channel name that is not already a plain file name (`notes/live`, `a b`) gets a short digest appended
in those three places, so two different channel names never share a daemon log, a history file or an
IPython profile.

Retained logs are pruned at session start (3 days, 200 files).

## Development

```bash
npm install
npm run dev          # watch src/, test/, python/ and re-run the affected suite
npm run check        # typecheck + lint + vitest + pytest, once
npm run py:test      # pytest against the same venv `run` uses
npm run py:env       # create the Python environment and print where it is
```

Both suites drive **real processes**: pytest spawns the daemon and speaks the wire protocol to it,
vitest loads the extension the way pi does and runs real channel daemons. Design, decisions and the
remaining milestones are in [`docs/DESIGN.md`](docs/DESIGN.md); gotchas and debugging tricks are in
[`docs/DEV.md`](docs/DEV.md).
