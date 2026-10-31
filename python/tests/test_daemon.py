"""Drive a real channel daemon over the real protocol.

These tests spawn the daemon the way the host does — pipes on stdin/stdout/stderr, JSON lines in and
out, a raw capture stream back — and assert on what comes out of it. They are the contract for the
TypeScript side: if a test here disagrees with `src/wire.ts`, one of them is wrong.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PYTHON_DIR = REPO / "python"
SENTINEL = re.compile(rb"\x00\x1ePIRB\x1e([a-z0-9-]+)\n")


class Daemon:
    """A channel daemon plus the two streams it speaks."""

    def __init__(self, tmp_path: Path, channel: str = "main", cwd: Path | None = None) -> None:
        self.channel = channel
        self.log_path = tmp_path / f"daemon-{channel}.log"
        env = dict(os.environ)
        env["PYTHONPATH"] = str(PYTHON_DIR)
        env["PYTHONUNBUFFERED"] = "1"
        env["IPYTHONDIR"] = str(tmp_path / "ipython")
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "replmode", "--channel", channel, "--log", str(self.log_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(cwd or REPO),
            env=env,
        )
        self.frames: list[dict] = []
        self.capture = bytearray()
        self.exited: tuple[int | None, str | None] | None = None
        self._lock = threading.Lock()
        threading.Thread(target=self._read_frames, daemon=True).start()
        threading.Thread(target=self._read_capture, daemon=True).start()
        self.ready = self.wait_frame("ready", timeout=60)

    # ── plumbing ──────────────────────────────────────────────────────────────

    def _read_frames(self) -> None:
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                with self._lock:
                    self.frames.append(json.loads(line))
            except ValueError:
                with self._lock:
                    self.frames.append({"t": "_nonjson", "line": line.decode("utf-8", "replace")})

    def _read_capture(self) -> None:
        while True:
            chunk = os.read(self.proc.stderr.fileno(), 1 << 16)
            if not chunk:
                return
            with self._lock:
                self.capture += chunk

    def send(self, frame: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(frame) + "\n").encode())
        self.proc.stdin.flush()

    def snapshot(self) -> tuple[list[dict], bytes]:
        with self._lock:
            return list(self.frames), bytes(self.capture)

    def wait_frame(self, kind: str, exec_id: str | None = None, timeout: float = 30.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            frames, _ = self.snapshot()
            for frame in frames:
                if frame.get("t") != kind:
                    continue
                if exec_id is not None and frame.get("id") != exec_id:
                    continue
                return frame
            if kind != "ready" and self.exited is not None:
                raise AssertionError(f"daemon exited ({self.exited}) while waiting for a {kind!r} frame; frames={frames}")
            time.sleep(0.02)
        raise AssertionError(f"timed out waiting for a {kind!r} frame")

    def execute(self, code: str, timeout: float = 30.0, exec_id: str = "repl-test01") -> tuple[dict, str]:
        """Run a cell and return its `exec_end` frame and its captured block, sentinels removed."""
        self.send({"t": "execute", "id": exec_id, "code": code})
        frame = self.wait_frame("exec_end", exec_id, timeout)
        block = self.wait_blocks(exec_id, timeout)
        return frame, block

    def wait_blocks(self, exec_id: str, timeout: float = 30.0) -> str:
        """The text between the two sentinels of `exec_id`, once both have arrived."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            marks = [(match.start(), match.group(1).decode()) for match in SENTINEL.finditer(self.snapshot()[1])]
            occurrences = [index for index, (_, marker_id) in enumerate(marks) if marker_id == exec_id]
            if len(occurrences) >= 2:
                start, end = occurrences[0], occurrences[1]
                block_start = marks[start][0] + len(marker_bytes(exec_id))
                block_end = marks[end][0]
                return self.snapshot()[1][block_start:block_end].decode("utf-8", "replace")
            time.sleep(0.02)
        raise AssertionError(f"timed out waiting for the capture block of {exec_id}")

    def sentinel_ids(self) -> list[str]:
        return [match.group(1).decode() for match in SENTINEL.finditer(self.snapshot()[1])]

    def interrupt(self) -> None:
        self.proc.send_signal(signal.SIGINT)

    def wait_exit(self, timeout: float = 20.0) -> int | None:
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise AssertionError(f"daemon did not exit within {timeout}s") from error

    def poll_exit(self) -> None:
        code = self.proc.poll()
        if code is not None:
            self.exited = (code, None)

    def shutdown(self) -> int | None:
        try:
            self.send({"t": "shutdown"})
        except (BrokenPipeError, ValueError):
            pass
        return self.wait_exit()

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=5)


def marker_bytes(exec_id: str) -> bytes:
    return b"\x00\x1ePIRB\x1e" + exec_id.encode() + b"\n"


@pytest.fixture()
def daemon(tmp_path: Path):
    channel = Daemon(tmp_path)
    try:
        yield channel
    finally:
        channel.close()


# ── Startup ──────────────────────────────────────────────────────────────────


def test_ready_reports_the_environment(tmp_path: Path, daemon: Daemon) -> None:
    ready = daemon.ready
    assert ready["channel"] == "main"
    assert ready["pid"] == daemon.proc.pid
    assert ready["python"] == ".".join(map(str, sys.version_info[:3]))
    import IPython

    assert ready["ipython"] == IPython.__version__
    assert ready["cwd"] == str(REPO)
    assert ready["startup_ms"] < 20_000


def test_daemon_diagnostics_go_to_the_log_file_not_the_streams(daemon: Daemon) -> None:
    assert daemon.wait_frame("ready")["log"] == str(daemon.log_path)
    daemon.shutdown()
    text = daemon.log_path.read_text()
    assert "shutdown requested" in text
    # Nothing on the protocol or capture stream looks like a log line of its own.
    assert all(frame["t"] != "_nonjson" for frame in daemon.snapshot()[0])


def test_shutdown_exits_cleanly(daemon: Daemon) -> None:
    assert daemon.shutdown() == 0


def test_an_interrupt_arriving_while_the_channel_is_idle_does_not_wedge_it(daemon: Daemon) -> None:
    """A SIGINT can land inside the event loop instead of inside a cell.

    That is what happens when an interrupt races a cell boundary, or when the host stops something
    that had already finished. The loop catches it, re-enters, and the pending stdin read still
    delivers the next frame.
    """
    time.sleep(0.5)
    daemon.interrupt()
    time.sleep(0.2)
    daemon.interrupt()
    time.sleep(0.2)
    assert daemon.proc.poll() is None

    _, out = daemon.execute("print('fine')", exec_id="repl-idle01")
    assert "fine" in out
    assert "KeyboardInterrupt outside a cell" in daemon.log_path.read_text()


def test_pi_namespace_is_available_in_cells(daemon: Daemon) -> None:
    code = f"print(pi.channel, pi.daemon_pid == {daemon.proc.pid}, pi.python_version, pi.cwd)"
    _, out = daemon.execute(code)
    assert "main True" in out


# ── Cells ────────────────────────────────────────────────────────────────────


def test_state_persists_across_cells(daemon: Daemon) -> None:
    daemon.execute("value = {'a': 1}", exec_id="repl-one000")
    _, out = daemon.execute("value['a'] += 41\nprint(value)", exec_id="repl-two000")
    assert out.strip().endswith("{'a': 42}")


def test_trailing_expression_is_shown_like_a_repl(daemon: Daemon) -> None:
    _, out = daemon.execute("40 + 2")
    assert "42" in out


def test_capture_catches_python_and_subprocess_output(daemon: Daemon) -> None:
    _, out = daemon.execute(
        "import sys, os\nprint('to stdout')\nprint('to stderr', file=sys.stderr)\nos.system('echo from-os-system')",
        exec_id="repl-capt01",
    )
    assert "to stdout" in out
    assert "to stderr" in out
    assert "from-os-system" in out


def test_magics_and_bang_work(daemon: Daemon) -> None:
    _, out = daemon.execute("!echo from-bang", exec_id="repl-bang01")
    assert "from-bang" in out
    _, out = daemon.execute("import os as _os\n%who_ls", exec_id="repl-magic1")
    assert "[" in out


def test_top_level_await_runs_in_the_daemon_loop(daemon: Daemon) -> None:
    _, out = daemon.execute(
        "import asyncio\nawait asyncio.sleep(0.05)\nprint('awaited')",
        exec_id="repl-await1",
    )
    assert "awaited" in out
    _, out = daemon.execute("import asyncio\nprint(asyncio.get_event_loop().is_running())", exec_id="repl-await2")
    assert "True" in out


def test_each_exec_is_bracketed_by_two_sentinels(daemon: Daemon) -> None:
    daemon.execute("print('one')", exec_id="repl-brack1")
    daemon.execute("print('two')", exec_id="repl-brack2")
    assert daemon.sentinel_ids() == ["repl-brack1", "repl-brack1", "repl-brack2", "repl-brack2"]


def test_a_cell_can_see_the_output_of_the_previous_one(daemon: Daemon) -> None:
    daemon.execute("print('first')", exec_id="repl-seq001")
    _, out = daemon.execute("print('second')", exec_id="repl-seq002")
    assert out.strip() == "second"


# ── Errors and interrupts ────────────────────────────────────────────────────


def test_traceback_is_reported_once_and_without_colour(daemon: Daemon) -> None:
    frame, out = daemon.execute("def boom():\n    1/0\nboom()", exec_id="repl-err001")
    assert frame["ok"] is False
    assert frame["status"] == "error"
    assert frame["ename"] == "ZeroDivisionError"
    assert frame["evalue"] == "division by zero"
    assert "ZeroDivisionError" in frame["traceback"]
    assert "boom()" in frame["traceback"]
    assert "\x1b[" not in frame["traceback"]
    # The capture keeps what the cell printed; the traceback arrives as a frame instead.
    assert "ZeroDivisionError" not in out


def test_syntax_error_is_a_failed_cell(daemon: Daemon) -> None:
    frame, _ = daemon.execute("def broken(:\n    pass", exec_id="repl-synt001")
    assert frame["status"] == "error"
    assert frame["ename"] == "SyntaxError"
    # and the shell is still usable
    _, out = daemon.execute("print('still here')", exec_id="repl-synt002")
    assert "still here" in out


def test_interrupt_stops_the_cell_and_keeps_the_channel(daemon: Daemon) -> None:
    daemon.send({"t": "execute", "id": "repl-loop01", "code": "marker = 'kept'\nimport time\nwhile True:\n    time.sleep(0.05)"})
    deadline = time.time() + 20
    while time.time() < deadline:
        if daemon.proc.poll() is not None:
            pytest.fail("daemon died instead of interrupting the cell")
        time.sleep(0.3)
        daemon.interrupt()
        frames, _ = daemon.snapshot()
        if any(f.get("t") == "exec_end" and f.get("id") == "repl-loop01" for f in frames):
            break
    frame = daemon.wait_frame("exec_end", "repl-loop01")
    assert frame["status"] == "interrupted"
    assert frame["ename"] == "KeyboardInterrupt"

    _, out = daemon.execute("print(marker)", exec_id="repl-after1")
    assert "kept" in out


def test_keyboard_interrupt_raised_by_the_cell_is_reported_as_interrupted(daemon: Daemon) -> None:
    frame, _ = daemon.execute("raise KeyboardInterrupt('explicit')", exec_id="repl-keyb01")
    assert frame["status"] == "interrupted"


def test_code_that_blocks_sigint_is_not_the_daemons_problem(daemon: Daemon) -> None:
    # The daemon must still be alive and interruptible afterwards: the mask is only held across the
    # exec boundary writes, never across the cell.
    _, out = daemon.execute(
        "import signal\nsignal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})\nprint('blocked')",
        exec_id="repl-mask01",
    )
    assert "blocked" in out
    frame, _ = daemon.execute("raise KeyboardInterrupt('after mask')", exec_id="repl-mask02")
    assert frame["status"] == "interrupted"


# ── Guards and setvar ────────────────────────────────────────────────────────


def test_input_is_blocked_because_stdin_is_the_protocol(daemon: Daemon) -> None:
    frame, _ = daemon.execute("input('what?')", exec_id="repl-inp001")
    assert frame["status"] == "error"
    assert "stdin carries the pi protocol" in frame["evalue"]


def test_exit_does_not_kill_the_channel(daemon: Daemon) -> None:
    frame, _ = daemon.execute("exit()", exec_id="repl-exit01")
    assert frame["status"] == "error"
    assert daemon.proc.poll() is None
    _, out = daemon.execute("print('channel alive')", exec_id="repl-exit02")
    assert "channel alive" in out


def test_setvar_binds_text_and_a_file(daemon: Daemon, tmp_path: Path) -> None:
    (tmp_path / "full.log").write_text("the whole capture\n", encoding="utf-8")
    daemon.send({"t": "setvar", "name": "_out_text1", "text": "inline capture"})
    daemon.send({"t": "setvar", "name": "_out_path1", "path": str(tmp_path / "full.log")})
    _, out = daemon.execute("print(len(_out_text1), _out_path1.strip())", exec_id="repl-var001")
    assert "14 the whole capture" in out


def test_setvar_rejects_a_bad_name(daemon: Daemon) -> None:
    daemon.send({"t": "setvar", "name": "not an identifier", "text": "x"})
    _, out = daemon.execute("print('ok')", exec_id="repl-var002")
    assert "ok" in out
    assert daemon.proc.poll() is None


# ── Death and scale ──────────────────────────────────────────────────────────


def test_a_cell_that_exits_the_process_ends_the_daemon(daemon: Daemon) -> None:
    daemon.send({"t": "execute", "id": "repl-die001", "code": "print('bye')\nimport os\nos._exit(7)"})
    assert daemon.wait_exit(timeout=20) == 7
    # Whatever the cell managed to print is in the capture stream, before the stream closes.
    assert b"bye" in daemon.snapshot()[1]


def test_large_output_survives_the_pipes(daemon: Daemon) -> None:
    _, out = daemon.execute("for i in range(20000): print(f'line {i}')", exec_id="repl-big001", timeout=60)
    assert out.startswith("line 0\n")
    assert out.rstrip().endswith("line 19999")
    assert len(out) > 200_000


def test_unicode_output_is_not_mangled(daemon: Daemon) -> None:
    _, out = daemon.execute("print('héllo ✓ 日本語')", exec_id="repl-uni001")
    assert "héllo ✓ 日本語" in out


def test_two_channels_are_independent(tmp_path: Path) -> None:
    a = Daemon(tmp_path, channel="alpha")
    b = Daemon(tmp_path, channel="beta")
    try:
        assert a.ready["channel"] == "alpha"
        a.execute("only_in_alpha = 1", exec_id="repl-ch0001")
        _, out = b.execute("print('only_in_alpha' in dir())", exec_id="repl-ch0002")
        assert "False" in out
    finally:
        a.close()
        b.close()


def test_unknown_and_malformed_frames_are_reported_and_ignored(daemon: Daemon) -> None:
    daemon.send({"t": "nonsense"})
    assert daemon.proc.stdin is not None
    daemon.proc.stdin.write(b"this is not json\n")
    daemon.proc.stdin.flush()
    _, out = daemon.execute("print('still working')", exec_id="repl-junk01")
    assert "still working" in out
    levels = [frame for frame in daemon.snapshot()[0] if frame.get("t") == "log"]
    assert any("unknown frame" in frame["text"] for frame in levels)
    assert any("malformed frame" in frame["text"] for frame in levels)
