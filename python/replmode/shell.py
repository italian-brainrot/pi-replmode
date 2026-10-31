"""The IPython shell the daemon runs, and the `pi` namespace every cell starts with.

Two things here are not the default IPython behaviour and both matter:

* tracebacks do not go to the capture stream. `_showtraceback` is IPython's documented side channel
  for exactly this: the daemon keeps the text and puts it in the `exec_end` frame, so the host can
  mark the call failed and place the traceback after the output that preceded it without the cell's
  output and the traceback arriving as two unconnected pieces of text. `colors="NoColor"` keeps ANSI
  out of it.
* only the `text/plain` formatter is enabled. With the defaults, every displayed object pays for
  `_repr_html_`, `_repr_png_` and friends — a DataFrame rendering an HTML table on every call — and
  the display hook would print only the plain text anyway. Rich display (M3) asks the formatter
  chain for specific mime types when it actually wants them.
"""

from __future__ import annotations

import builtins
import io
import os
import sys
import types
from typing import Any

from IPython.core.interactiveshell import InteractiveShell

from . import __version__

#: Names the daemon owns in the user namespace; never reported as "definitions added by the cell".
RESERVED_NS_NAMES = frozenset(
    {
        "pi",
        "exit",
        "quit",
        "quit0",
        "In",
        "Out",
        "get_ipython",
        "__builtin__",
        "__builtins__",
        "__name__",
        "__doc__",
        "__package__",
        "__loader__",
        "__spec__",
        "__debug__",
    }
)


class ReplmodeShell(InteractiveShell):
    """An InteractiveShell that reports tracebacks to the daemon instead of to stdout."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.replmode_tracebacks: list[dict[str, str]] = []

    def reset_tracebacks(self) -> None:
        self.replmode_tracebacks = []

    def _showtraceback(self, etype: type[BaseException], evalue: BaseException, stb: list[str]) -> None:  # type: ignore[override]
        """Collect the traceback for the `exec_end` frame rather than printing it.

        Mirrors the base method's contract (same arguments, same `showing_traceback` flag); only the
        destination changes.
        """
        try:
            text = self.InteractiveTB.stb2text(stb)
        except Exception:
            text = "".join(stb) if all(isinstance(item, str) for item in stb) else repr(stb)
        self.replmode_tracebacks.append(
            {
                "ename": getattr(etype, "__name__", str(etype)),
                "evalue": _safe_str(evalue),
                "text": text,
            }
        )
        # The base implementation sets this so `%tb` and friends can tell a traceback was shown.
        self.showing_traceback = True


def _safe_str(value: Any) -> str:
    try:
        return str(value)
    except BaseException as error:  # noqa: BLE001 - an unprintable exception is still an exception
        return f"<{type(value).__name__}: str() raised {type(error).__name__}>"


def create_shell(channel: str) -> ReplmodeShell:
    """Build the shell for a channel, configured for headless, machine-readable use."""
    # `colors` is a theme name in IPython 9, and setting it up front is what keeps ANSI out of
    # tracebacks and source echo without tripping the deprecation observer that a later change emits.
    shell = ReplmodeShell.instance(colors="nocolor")
    if getattr(shell, "_replmode_configured", False):
        return shell  # pragma: no cover - one shell per process, defensive

    shell.interactive = False

    for name, formatter in shell.display_formatter.formatters.items():
        formatter.enabled = name == "text/plain"

    # Prompts and the `In[n]` bookkeeping are noise in a captured stream; `Out[n]:` stays, because
    # "type an expression, see its repr" is the REPL semantics the spec asks for.
    shell.separate_in = ""
    shell.separate_out = ""
    shell.separate_out2 = ""

    shell._replmode_configured = True
    install_pi_namespace(shell, channel)
    return shell


# ── The `pi` namespace ───────────────────────────────────────────────────────


def install_pi_namespace(shell: ReplmodeShell, channel: str) -> None:
    """Put `pi` (and the guards) into the namespace every cell runs in."""
    module = types.ModuleType("pi")
    module.__doc__ = "pi-replmode context and tools, available in every cell."
    module.channel = channel
    module.cwd = os.getcwd()
    module.daemon_pid = os.getpid()
    module.replmode_version = __version__
    module.python_version = sys.version.split()[0]
    module.ipython_version = _ipython_version()

    shell.user_ns["pi"] = module
    sys.modules["pi"] = module

    _neutralize_exit(shell)
    _guard_input(module)


def _ipython_version() -> str:
    import IPython

    return IPython.__version__


def _neutralize_exit(shell: ReplmodeShell) -> None:
    """Make `exit()` a failed cell rather than a dead channel.

    IPython already keeps SystemExit from a cell from leaving the shell, but the default `exit`
    object prints its own help text and a bare `exit` at the end of a cell would still raise. A
    clear error is better than either.
    """

    def no_exit(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("exit()/quit() do nothing here: a pi-replmode channel lives as long as pi says.")

    for name in ("exit", "quit", "quit0"):
        shell.user_ns[name] = no_exit


def _guard_input(module: types.ModuleType) -> None:
    """`input()` would read protocol frames off stdin, so it is not available."""

    def blocked_input(*_args: Any, **_kwargs: Any) -> None:
        hint = "Use pi.ask(question, choices) to ask the user instead." if hasattr(module, "ask") else ""
        raise RuntimeError(f"input() is not available in a pi-replmode channel: stdin carries the pi protocol. {hint}".strip())

    builtins.input = blocked_input


def flush_streams() -> None:
    """Flush every user-visible buffer before an exec boundary, so blocks are not torn apart.

    The sentinel is written at the file-descriptor level, so anything still sitting in Python's text
    buffers would land on the wrong side of it.
    """
    for stream in (sys.stdout, sys.stderr, sys.__stdout__, sys.__stderr__):
        try:
            if isinstance(stream, io.TextIOBase | io.BufferedIOBase):
                stream.flush()
        except Exception:
            # A stream the user's code broke is not worth failing the exec over.
            pass
