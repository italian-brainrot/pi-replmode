"""Adversarial coverage of the interrupt design and the frame loop.

The suite in `test_daemon.py` covers the happy path of every protocol feature. This file probes the
places where a failure is expensive and easy to miss: an interrupt that has to reach a cell that is
not running Python bytecode, a frame handler that raises, input that is hostile rather than merely
malformed, and a cell that damages the streams the daemon depends on.

Tests whose comment names an issue id (R1-nn, R2-nn) are the ones that document a defect found by an
audit pass: they are expected to fail until the daemon is fixed.
"""

from __future__ import annotations

import os
import re
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


# ── Holding the fixes down ───────────────────────────────────────────────────
#
# Each of these is an attempt to defeat a fix made after the pass-1 audit: an interrupt that has to
# survive a cell that absorbs it, a capture stream damaged in a way the first fix did not imagine,
# and the daemon's own descriptors, which user code can reach.


def test_an_interrupt_the_cell_absorbs_escalates_to_stopping_the_cell(daemon: Daemon) -> None:
    """A second SIGINT has to reach a cell that caught the first one and went back to waiting."""
    daemon.send(
        {
            "t": "execute",
            "id": "repl-absorb",
            "code": "import asyncio\nfor _ in range(3):\n    try:\n        await asyncio.sleep(20)\n    except KeyboardInterrupt:\n        print('caught, waiting again')\nprint('finished')",
        }
    )
    time.sleep(0.8)
    daemon.interrupt()
    time.sleep(0.4)
    daemon.interrupt()

    frame = daemon.wait_frame("exec_end", "repl-absorb", timeout=10)
    assert frame["status"] == "interrupted", f"the cell was never stopped: {frame}"
    assert daemon.proc.poll() is None
    _, out = daemon.execute("print('usable')", exec_id="repl-absorb2")
    assert "usable" in out
    # Reaching an await the second time means cancelling, which is reported honestly in the log.
    assert "CancelledError" in daemon.log_path.read_text()


def test_interrupt_reaches_a_cell_parked_on_a_thread_pool_call(daemon: Daemon) -> None:
    """`await asyncio.to_thread(...)` parks the cell on a future the daemon can put an interrupt on."""
    daemon.send(
        {"t": "execute", "id": "repl-tothr1", "code": "import asyncio, time\nawait asyncio.to_thread(time.sleep, 20)\nprint('finished')"}
    )
    time.sleep(1.0)
    daemon.interrupt()

    frame = daemon.wait_frame("exec_end", "repl-tothr1", timeout=10)
    assert frame["status"] == "interrupted", f"the cell was not interrupted: {frame}"
    assert frame["ename"] == "KeyboardInterrupt"
    _, out = daemon.execute("print('usable')", exec_id="repl-tothr2")
    assert "usable" in out


def test_a_cell_that_installs_a_custom_sigint_handler_does_not_disable_interrupts(daemon: Daemon) -> None:
    """R1-02 again, with a handler that returns instead of `SIG_IGN`."""
    _, out = daemon.execute(
        "import signal\nsignal.signal(signal.SIGINT, lambda *args: None)\nprint('handler installed')",
        exec_id="repl-hand01",
    )
    assert "handler installed" in out

    daemon.send({"t": "execute", "id": "repl-hand02", "code": "import time\nwhile True:\n    time.sleep(0.05)"})
    time.sleep(0.8)
    daemon.interrupt()
    frame = daemon.wait_frame("exec_end", "repl-hand02", timeout=10)
    assert frame["status"] == "interrupted", "a custom handler survived into the next cell"
    assert "restored" in daemon.log_path.read_text()


def test_a_cell_that_closes_its_python_streams_does_not_blind_the_channel(daemon: Daemon) -> None:
    """`sys.stdout.close()` is not the same wound as `os.close(2)`: the stream object is gone too."""
    daemon.execute("import sys\nsys.stdout.close()\nsys.stderr.close()", exec_id="repl-strm01")

    _, out = daemon.execute("print('the channel can see output again')", exec_id="repl-strm02")
    assert "output again" in out
    assert daemon.proc.poll() is None


def test_a_cell_that_redirects_its_streams_does_not_take_the_next_cells_output_with_it(daemon: Daemon) -> None:
    """A redirect belongs to the cell that made it; the next cell starts with working streams."""
    _, first = daemon.execute(
        "import os\nnull = os.open('/dev/null', os.O_WRONLY)\nos.dup2(null, 1)\nos.dup2(null, 2)\nprint('sent to the void')",
        exec_id="repl-redirect1",
    )
    assert "sent to the void" not in first

    _, out = daemon.execute("print('back to the pipe')", exec_id="repl-redirect2")
    assert "back to the pipe" in out


def test_a_cell_that_leaves_sigint_pending_across_the_boundary_does_not_deafen_the_channel(
    daemon: Daemon,
) -> None:
    """The racy variant of R1-03: the signal outlives the cell that raised it.

    Blocking SIGINT and killing the process from inside a cell leaves it pending; it is delivered as
    soon as the daemon unblocks it at the exec boundary, somewhere in the epilogue rather than in the
    cell. Before the dispatch guard that ended the `serve` task and left the daemon alive and mute.
    """
    daemon.send(
        {
            "t": "execute",
            "id": "repl-pend01",
            "code": "import signal, os\nsignal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})\nos.kill(os.getpid(), signal.SIGINT)\nprint('raised while blocked')",
        }
    )
    time.sleep(0.8)
    assert daemon.proc.poll() is None, "a pending SIGINT killed the daemon"

    # Where the interrupt lands depends on when the pending signal is delivered: in the epilogue, which
    # reports the cell interrupted, or just after it, which the loop catches and carries on from.
    frame = daemon.wait_frame("exec_end", "repl-pend01", timeout=10)
    assert frame["status"] in ("ok", "interrupted"), frame
    _, out = daemon.execute("print('answered after a pending SIGINT')", exec_id="repl-pend02")
    assert "answered" in out


def test_a_cell_that_closes_the_daemons_own_descriptors_ends_the_channel_cleanly(daemon: Daemon) -> None:
    """The protocol and capture descriptors are only safe from user code up to a point.

    A cell can close everything the daemon holds. What it must not be able to do is leave a process
    that is alive, holds the channel, and can never answer again: the daemon notices it cannot talk
    and exits, so the host's death path reports the truth instead of waiting out a timeout.
    """
    daemon.send(
        {
            "t": "execute",
            "id": "repl-closefd",
            "code": "import os\nfor fd in [int(x) for x in os.listdir('/proc/self/fd') if int(x) > 2]:\n    try:\n        os.close(fd)\n    except OSError:\n        pass\nprint('everything else is gone')",
        }
    )
    code = daemon.wait_exit(timeout=20)
    assert code is not None and code != 0, f"a daemon that cannot talk should exit, not hang (got {code})"


# ── Pass 2: how far the `await` interrupt actually reaches ───────────────────
#
# `Runner.interrupt_cell` descends `task._fut_waiter` to find the future to put the KeyboardInterrupt
# on. That is a private asyncio attribute, so every shape of `await` a cell can park on is a way for
# the descent to be wrong: a task leaked, the loop hung, or the cell never stopped.

AWAIT_SHAPES = {
    # A child task inside a TaskGroup: the descent has to land on the child's own waiter and the
    # group's error handling must not swallow or multiply the interrupt.
    "taskgroup": "async with asyncio.TaskGroup() as tg:\n    tg.create_task(asyncio.sleep(20))",
    # A shield leaves an inner task running on purpose: the interrupt may stop the cell, but the
    # shielded task must not be left in a state that later surfaces as an unretrieved error.
    "shield": "await asyncio.shield(asyncio.sleep(20))",
    "gather_shield": "await asyncio.gather(asyncio.shield(asyncio.sleep(20)), asyncio.sleep(20))",
    # A future that another task of the cell's own is waiting on as well.
    "shared_event": "ev = asyncio.Event()\nasync def other():\n    await ev.wait()\ntask = asyncio.create_task(other())\nawait ev.wait()",
    # The transport's own exit waiters, which the child watcher completes from the loop.
    "subprocess_transport": "proc = await asyncio.create_subprocess_exec('sleep', '20')\nawait proc.communicate()",
    # An executor future that a worker thread will complete whether we like it or not.
    "executor": "await asyncio.get_running_loop().run_in_executor(None, time.sleep, 20)",
    # A `finally` that has to run for the cell to release a file it opened.
    "in_a_with_block": "with open(os.devnull) as handle:\n    await asyncio.sleep(20)",
}


def test_an_interrupt_reaches_a_cell_parked_on_any_shape_of_await(daemon: Daemon) -> None:
    """R1-01's fix has to work for the awaits a model actually writes, not just `asyncio.sleep`."""
    for index, (shape, body) in enumerate(AWAIT_SHAPES.items()):
        exec_id = f"repl-shape{index:02d}"
        code = f"import asyncio, os, time\nprint('started {shape}')\n{body}\nprint('finished {shape}')"
        daemon.send({"t": "execute", "id": exec_id, "code": code})
        time.sleep(0.7)
        daemon.interrupt()

        try:
            frame = daemon.wait_frame("exec_end", exec_id, timeout=12)
        except AssertionError as error:  # a shape that hangs the loop is the worst failure
            raise AssertionError(f"{shape}: the cell was never stopped; daemon alive={daemon.proc.poll() is None}") from error
        assert frame["status"] == "interrupted", f"{shape}: the cell was not interrupted: {frame}"
        assert daemon.proc.poll() is None, f"{shape}: the interrupt killed the daemon"

        _, out = daemon.execute(f"print('usable after {shape}')", exec_id=f"repl-shape{index:02}b")
        assert f"usable after {shape}" in out, f"{shape}: the channel stopped answering"


def test_interrupts_across_exec_boundaries_never_tear_a_sentinel(daemon: Daemon) -> None:
    """The `deferred_interrupt` block exists so a SIGINT cannot land mid-marker.

    Interrupts are fired continuously while cells start and finish, where the opening and closing
    sentinels are written. Every exec must still be bracketed by exactly two whole markers: one torn
    marker is a block that never closes, and the host would wait for a boundary that never arrives.
    """
    ids = [f"repl-storm{i:02d}" for i in range(12)]
    for exec_id in ids:
        daemon.send(
            {
                "t": "execute",
                "id": exec_id,
                "code": "print('cell start')\nimport time\ntime.sleep(0.15)\nprint('cell end')",
            }
        )
        time.sleep(0.02)
        daemon.interrupt()

    deadline = time.time() + 30
    while time.time() < deadline:
        frames, _ = daemon.snapshot()
        if sum(1 for frame in frames if frame.get("t") == "exec_end") >= len(ids):
            break
        time.sleep(0.1)

    frames, capture = daemon.snapshot()
    ends = [frame for frame in frames if frame.get("t") == "exec_end"]
    assert len(ends) == len(ids), f"{len(ends)} of {len(ids)} cells reported in"
    assert daemon.proc.poll() is None, "the interrupt storm killed the daemon"

    markers = re.findall(rb"\x00\x1ePIRB\x1e([a-z0-9-]*)\n", capture)
    for exec_id in ids:
        seen = markers.count(exec_id.encode())
        assert seen == 2, f"{exec_id} is bracketed by {seen} markers, not 2: the block is torn"
    # A marker whose bytes were written but whose id was never finished is a block that never closes:
    # the prefix count and the completed-marker count have to agree exactly.
    prefixes = capture.count(b"\x00\x1ePIRB\x1e")
    assert prefixes == len(markers), f"{prefixes - len(markers)} boundary markers were started and never completed"

    _, out = daemon.execute("print('usable after the storm')", exec_id="repl-storm99")
    assert "usable after the storm" in out


def test_a_cell_that_moves_fd_1_onto_its_own_pipe_does_not_blind_the_channel(daemon: Daemon) -> None:
    """R1-05's repair, with a redirect harder than `/dev/null`.

    A cell that puts a pipe it made itself onto fd 1 points the stream at something with a reader
    attached. The repair compares device and inode, so it has to notice; if it did not, the cell's
    output would go into the pipe forever and the marker would still be written to the daemon's own
    reference, which is exactly the kind of silent half-capture this design cannot afford.
    """
    _, first = daemon.execute(
        "import os\nread_fd, write_fd = os.pipe()\nos.dup2(write_fd, 1)\nos.write(1, b'sent to my own pipe\\n')\nprint('not captured')\nos.close(write_fd)\nprint('read back', os.read(read_fd, 100))",
        exec_id="repl-pipe01",
        timeout=20,
    )
    assert "not captured" not in first, "the cell's own redirect was not honoured"
    assert "sent to my own pipe" not in first

    frames, capture = daemon.snapshot()
    junk = [frame for frame in frames if frame.get("t") == "_nonjson"]
    assert not junk, f"the cell's pipe leaked into the protocol: {junk}"
    assert b"my own pipe" not in capture, "the cell's private pipe was read as capture"

    assert daemon.proc.poll() is None
    _, out = daemon.execute("print('the next cell is captured again')", exec_id="repl-pipe02")
    assert "captured again" in out
    assert "restored fd" in daemon.log_path.read_text(), "the repair was not reported"


# ── Pass 2: the cell cannot reach the protocol ───────────────────────────────


def test_the_debugger_cannot_eat_the_protocol(daemon: Daemon) -> None:
    """`breakpoint()` and `%debug` are things models really write, and pdb reads stdin.

    stdin is the protocol. A debugger that got a real read would consume the host's next frame and
    leave the channel waiting for an answer that was eaten.
    """
    frame, _ = daemon.execute("x = 1\nbreakpoint()\nprint('after')", exec_id="repl-bp0001")
    assert frame["status"] == "error", f"breakpoint() did not fail with a clear error: {frame}"
    assert "stdin carries the pi protocol" in (frame.get("evalue") or "")
    assert daemon.proc.poll() is None

    debug_frame, _ = daemon.execute("%debug 1/0", exec_id="repl-dbg001", timeout=20)
    assert debug_frame["status"] in ("ok", "error", "interrupted"), debug_frame
    assert daemon.proc.poll() is None, "the debugger killed the daemon"

    _, out = daemon.execute("print('the debugger took nothing off the wire')", exec_id="repl-dbg002")
    assert "took nothing off the wire" in out


def test_a_cell_reading_stdin_does_not_block_the_channel(daemon: Daemon) -> None:
    """`sys.stdin` is the protocol pipe, and the daemon keeps it non-blocking for that reason.

    A blocking read on fd 0 would stop the loop, and the bytes it took would be frames the host is
    still waiting on.
    """
    frame, block = daemon.execute("import sys\nprint('read', repr(sys.stdin.readline()))", exec_id="repl-std001", timeout=15)
    assert frame["status"] in ("ok", "error"), frame
    assert daemon.proc.poll() is None, "reading stdin hung the daemon"
    assert "read" in block

    _, out = daemon.execute("print('still answering')", exec_id="repl-std002")
    assert "still answering" in out
