"""Adversarial coverage of the interrupt design and the frame loop.

The suite in `test_daemon.py` covers the happy path of every protocol feature. This file probes the
places where a failure is expensive and easy to miss: an interrupt that has to reach a cell that is
not running Python bytecode, a frame handler that raises, input that is hostile rather than merely
malformed, and a cell that damages the streams the daemon depends on.

Tests whose comment names an issue id (R1-nn) are the ones that document a defect found in the
pass-1 audit: they are expected to fail until the daemon is fixed.
"""

from __future__ import annotations

import os
import signal
import time
from pathlib import Path

import pytest

from test_daemon import Daemon


@pytest.fixture()
def daemon(tmp_path: Path):
    """A real channel daemon, started the way the host starts one (see `test_daemon.py`)."""
    channel = Daemon(tmp_path)
    try:
        yield channel
    finally:
        channel.close()


# ── Interrupt delivery ───────────────────────────────────────────────────────


def test_interrupt_reaches_a_cell_that_is_waiting_at_top_level_await(daemon: Daemon) -> None:
    """R1-01: SIGINT during an `await` must end the cell, not be swallowed by the loop.

    The daemon owns the event loop the cell awaits on, so a SIGINT that lands while the cell is
    suspended never reaches it: CPython raises KeyboardInterrupt in the thread that is driving the
    loop, the daemon logs "KeyboardInterrupt outside a cell" and re-enters, and the cell resumes its
    sleep and runs to completion. `bg_stop` and an aborted call then report the cell as
    unresponsive, and the channel stays busy for the whole remaining await.
    """
    daemon.send({"t": "execute", "id": "repl-await01", "code": "import asyncio\nprint('sleeping')\nawait asyncio.sleep(20)\nprint('finished')"})
    # Wait until the cell is really running: its first line has reached the capture stream.
    deadline = time.time() + 20
    while time.time() < deadline and b"sleeping" not in daemon.snapshot()[1]:
        time.sleep(0.05)
    assert b"sleeping" in daemon.snapshot()[1], "the cell never started"
    time.sleep(0.3)
    daemon.interrupt()

    frame = daemon.wait_frame("exec_end", "repl-await01", timeout=6)
    assert frame["status"] == "interrupted", f"the await was not interrupted: {frame}"
    assert frame["ename"] == "KeyboardInterrupt"

    # and the channel is still a channel
    _, out = daemon.execute("print('usable')", exec_id="repl-await02")
    assert "usable" in out


def test_interrupt_is_still_delivered_to_later_cells_after_a_cell_uses_os_system(daemon: Daemon) -> None:
    """`os.system` ignores SIGINT while it waits for its child; the daemon must recover from that."""
    _, out = daemon.execute("import os\nos.system('sleep 0.2')\nprint('ran a command')", exec_id="repl-ossys1")
    assert "ran a command" in out

    daemon.send({"t": "execute", "id": "repl-ossys2", "code": "import time\nwhile True:\n    time.sleep(0.05)"})
    time.sleep(0.8)
    daemon.interrupt()
    frame = daemon.wait_frame("exec_end", "repl-ossys2", timeout=10)
    assert frame["status"] == "interrupted"


def test_a_cell_that_replaces_the_sigint_handler_does_not_disable_interrupts_for_the_channel(
    daemon: Daemon,
) -> None:
    """R1-02: one cell must not take interruptibility away from every later cell.

    The daemon normalizes the *signal mask* at each exec boundary but leaves the *disposition*
    alone, so `signal.signal(SIGINT, SIG_IGN)` (or a handler that returns) in one cell leaves the
    whole channel deaf for the rest of its life, and the only way out is losing its state.
    """
    _, out = daemon.execute(
        "import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nprint('changed')",
        exec_id="repl-ign001",
    )
    assert "changed" in out

    daemon.send({"t": "execute", "id": "repl-ign002", "code": "import time\nwhile True:\n    time.sleep(0.05)"})
    time.sleep(0.8)
    daemon.interrupt()
    frame = daemon.wait_frame("exec_end", "repl-ign002", timeout=10)
    assert frame["status"] == "interrupted", "the channel lost its interrupt handler for good"


def test_stacked_interrupts_leave_the_channel_usable(daemon: Daemon) -> None:
    """An odd number of interrupts: the extras must not wedge or kill the channel."""
    daemon.send({"t": "execute", "id": "repl-stack01", "code": "import time\nwhile True:\n    time.sleep(0.02)"})
    time.sleep(0.8)
    for _ in range(3):
        daemon.interrupt()
        time.sleep(0.05)
    frame = daemon.wait_frame("exec_end", "repl-stack01", timeout=10)
    assert frame["status"] == "interrupted"
    assert daemon.proc.poll() is None

    _, out = daemon.execute("print('still usable')", exec_id="repl-stack02")
    assert "still usable" in out


# ── The frame loop ───────────────────────────────────────────────────────────


def test_a_frame_handler_that_raises_does_not_leave_the_daemon_alive_but_deaf(
    daemon: Daemon, tmp_path: Path
) -> None:
    """R1-03: an exception escaping `serve()` must not orphan the channel.

    `setvar` on a path that blocks (a FIFO nobody will open) is interrupted by SIGINT: the
    KeyboardInterrupt propagates out of the `serve` task, the daemon's loop catches it, logs one
    line, and re-enters `run_until_complete` on the dead task. The process stays alive, reads no
    more frames, and never sends `fatal` — so every later `run` hangs until its timeout and the
    channel is stuck busy until it is killed.
    """
    fifo = tmp_path / "nobody-will-open-me"
    os.mkfifo(fifo)
    daemon.send({"t": "setvar", "name": "_out_fifo1", "path": str(fifo)})
    time.sleep(1.0)
    assert daemon.proc.poll() is None
    daemon.interrupt()
    time.sleep(0.5)

    daemon.send({"t": "execute", "id": "repl-fifo01", "code": "print('answer me')"})
    frame = daemon.wait_frame("exec_end", "repl-fifo01", timeout=10)
    assert frame["status"] == "ok", "the daemon stopped answering frames but stayed alive"


def test_a_hostile_frame_keeps_the_daemons_own_traceback_out_of_the_capture(daemon: Daemon) -> None:
    """R1-04: a frame that raises something other than ValueError must not print into the capture.

    `Inbox._read` only catches ValueError from `decode_frame`. A deeply nested JSON document raises
    RecursionError instead, which escapes the reader callback, and asyncio's default exception
    handler logs the traceback to stderr — which is the *capture stream*. The daemon's internals
    then appear inside a cell's output, and nothing is written to the daemon's log file.
    """
    assert daemon.proc.stdin is not None
    daemon.proc.stdin.write(b"[" * 200_000 + b"]" * 200_000 + b"\n")
    daemon.proc.stdin.flush()
    time.sleep(1.0)

    frame, out = daemon.execute("print('after hostile')", exec_id="repl-deep01")
    assert "after hostile" in out
    assert daemon.proc.poll() is None
    assert "Traceback" not in out and "asyncio" not in out, f"daemon internals leaked into the capture: {out[:400]}"
    assert "Traceback" in daemon.log_path.read_text() or "malformed" in daemon.log_path.read_text()


def test_a_cell_that_closes_the_capture_stream_does_not_kill_the_channel(daemon: Daemon) -> None:
    """R1-05 (preferred hardening): `_capture` writes to fd 2, which user code can close.

    The exec's closing sentinel is written in a `finally`, so an OSError there escapes `Runner.run`,
    kills the `serve` task, and takes the channel down — after `exec_end` has already been sent,
    which is what makes the host report the cell as completed (see R1-06 in the host suite).
    """
    daemon.send({"t": "execute", "id": "repl-close2", "code": "import os\nprint('before')\nos.close(2)\nprint('after')"})
    frame = daemon.wait_frame("exec_end", "repl-close2")
    assert frame["status"] == "ok"
    assert daemon.proc.poll() is None, "the daemon died because its capture stream went away"

    _, out = daemon.execute("print('channel survives')", exec_id="repl-close3")
    assert "channel survives" in out


def test_binary_bytes_in_the_capture_reach_the_host_unchanged(daemon: Daemon) -> None:
    """The capture stream is bytes: the daemon must not decode, re-encode or split them."""
    payload = b"raw:\x00\x01\x02\xfe\xff and a lone \\x1e: \x1e done\n"
    daemon.send({"t": "execute", "id": "repl-bin0001", "code": f"import sys\nsys.stdout.buffer.write({payload!r})"})
    deadline = time.time() + 30
    while time.time() < deadline:
        if payload in daemon.snapshot()[1]:
            break
        time.sleep(0.05)
    assert payload in daemon.snapshot()[1]
    daemon.wait_frame("exec_end", "repl-bin0001")


def test_the_frame_reader_keeps_its_place_after_junk_between_frames(daemon: Daemon) -> None:
    """Non-JSON, empty, JSON-scalar and unknown frames arrive interleaved with real work."""
    assert daemon.proc.stdin is not None
    daemon.proc.stdin.write(b"\n\n   \nnot json\n42\n[1,2]\n" + b'{"t":"setvar","name":"kept","text":"yes"}\n')
    daemon.proc.stdin.flush()

    _, out = daemon.execute("print(kept)", exec_id="repl-junk02")
    assert "yes" in out
    assert daemon.proc.poll() is None
