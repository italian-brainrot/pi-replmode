"""The daemon's event loop: read frames, run cells, keep the two output streams apart.

Startup order matters and is the whole trick:

    proto = dup(1)      # the protocol pipe, saved away
    dup2(2, 1)          # fd 1 now writes to the capture pipe like fd 2 does

From that point on, protocol frames go only to `proto`, and *everything* the user's code (or a
subprocess, or a C library) writes to fd 1 or fd 2 lands in the capture stream, in order, with no
Python-level buffering between them. The daemon's own diagnostics go to a log file and to `log`
frames — never to those descriptors.

The loop is a raw asyncio loop, never `asyncio.run()`: asyncio's runner installs a SIGINT handler
that cannot reach a coroutine stuck inside synchronous code, so `asyncio.run` makes the cell
uninterruptible. A raw loop leaves CPython's default handler in place, SIGINT raises
KeyboardInterrupt inside the running cell, IPython reports it, and the shell is ready for the next
cell. That is what `bg_stop` and an aborted foreground call rely on.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import signal
import sys
import time
import traceback
from collections.abc import Iterator
from typing import Any

from .shell import RESERVED_NS_NAMES, create_shell, flush_streams
from .wire import decode_frame, sentinel, write_frame

#: Frames this big are a bug, not a cell; refuse rather than allocate on a protocol desync.
MAX_FRAME_BYTES = 64 * 1024 * 1024


class Log:
    """Daemon diagnostics: a log file, plus a copy of anything notable as a `log` frame."""

    def __init__(self, path: str, proto_fd: int) -> None:
        self.path = path
        self.proto_fd = proto_fd
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        self.fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)

    def write(self, level: str, text: str) -> None:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {level}: {text}".rstrip() + "\n"
        try:
            os.write(self.fd, line.encode("utf-8", "backslashreplace"))
        except OSError:
            pass
        if level != "debug":
            try:
                write_frame(self.proto_fd, {"t": "log", "level": level, "text": text})
            except OSError:
                pass

    def debug(self, text: str) -> None:
        self.write("debug", text)

    def info(self, text: str) -> None:
        self.write("info", text)

    def warn(self, text: str) -> None:
        self.write("warn", text)

    def error(self, text: str) -> None:
        self.write("error", text)


class Inbox:
    """Line-buffered frames arriving on stdin.

    Uses the event loop's reader rather than `asyncio.StreamReader` so the same buffer can be drained
    synchronously later, which is how a cell that calls back into pi pumps its own reply (M3).
    """

    def __init__(self, fd: int, loop: asyncio.AbstractEventLoop) -> None:
        self.fd = fd
        self.loop = loop
        self.buffer = b""
        self.queue: asyncio.Queue[dict | None] = asyncio.Queue()
        self.eof = False
        try:
            os.set_blocking(fd, False)
        except (OSError, ValueError):
            # Not a pipe (a redirected file in a test, say); the reader still works via polling.
            pass
        loop.add_reader(fd, self._read)

    def close(self) -> None:
        try:
            self.loop.remove_reader(self.fd)
        except Exception:
            pass

    def _read(self) -> None:
        while True:
            try:
                chunk = os.read(self.fd, 1 << 16)
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                self._end()
                self.queue.put_nowait(None)
                return
            if not chunk:
                self._end()
                self.queue.put_nowait(None)
                return
            if len(self.buffer) + len(chunk) > MAX_FRAME_BYTES:
                self.buffer = b""
                self.queue.put_nowait({"t": "_overlong"})
                continue
            self.buffer += chunk
            while True:
                newline = self.buffer.find(b"\n")
                if newline < 0:
                    break
                line, self.buffer = self.buffer[:newline], self.buffer[newline + 1 :]
                if not line.strip():
                    continue
                try:
                    self.queue.put_nowait(decode_frame(line))
                except ValueError as error:
                    self.queue.put_nowait({"t": "_badjson", "detail": str(error), "line": line[:200].decode("utf-8", "replace")})

    def _end(self) -> None:
        if not self.eof:
            self.eof = True
            self.close()

    async def get(self) -> dict | None:
        return await self.queue.get()


def user_names(shell: Any) -> set[str]:
    """Names a cell introduced: user-visible globals, minus IPython's and the daemon's bookkeeping."""
    return {name for name in shell.user_ns if not name.startswith("_") and name not in RESERVED_NS_NAMES}


@contextlib.contextmanager
def deferred_interrupt() -> Iterator[None]:
    """Hold SIGINT back across an exec boundary write.

    A KeyboardInterrupt landing between the sentinel's bytes would leave half a marker in the capture
    stream, and the host would wait for a boundary that never arrives. Blocking the signal for the
    few microseconds of the write costs nothing; the signal is delivered as usual when the block is
    lifted, one bytecode later.
    """
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
    try:
        yield
    finally:
        # Unblock SIGINT itself, not whatever was blocked before: passing the saved mask back here
        # leaves SIGINT blocked, and every interrupt after the first exec boundary is then held
        # pending forever.
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT})


class Runner:
    """Runs one exec at a time, bracketing each with capture sentinels."""

    def __init__(self, shell: Any, proto_fd: int, log: Log, channel: str) -> None:
        self.shell = shell
        self.proto_fd = proto_fd
        self.log = log
        self.channel = channel

    def _capture(self, data: bytes) -> None:
        """Write to the capture stream. fd 2 is the capture pipe; fd 1 is a dup of it."""
        view = memoryview(data)
        while view:
            view = view[os.write(2, view):]

    def _begin(self, exec_id: str) -> None:
        with deferred_interrupt():
            flush_streams()
            self._capture(sentinel(exec_id))
        self.shell.reset_tracebacks()

    def _end(self, exec_id: str) -> None:
        with deferred_interrupt():
            flush_streams()
            self._capture(sentinel(exec_id))

    async def run(self, frame: dict) -> None:
        exec_id = frame.get("id")
        code = frame.get("code", "")
        if not isinstance(exec_id, str) or not exec_id:
            self.log.warn(f"execute frame without an id: {frame!r}")
            return
        try:
            sentinel(exec_id)
        except UnicodeEncodeError:
            self.log.warn(f"exec id is not ASCII, refusing: {exec_id!r}")
            return

        started = time.monotonic()
        before = user_names(self.shell)
        self._begin(exec_id)

        emitted = False
        try:
            try:
                transformed = self.shell.transform_cell(code)
                preprocessing_exc = None
            except BaseException:
                transformed, preprocessing_exc = code, sys.exc_info()

            result = await self.shell.run_cell_async(
                code,
                transformed_cell=transformed,
                preprocessing_exc_tuple=preprocessing_exc,
                store_history=True,
            )

            error = result.error_in_exec or result.error_before_exec
            if error is None:
                status = "ok"
            elif isinstance(error, KeyboardInterrupt):
                status = "interrupted"
            else:
                status = "error"

            tracebacks = self.shell.replmode_tracebacks
            last = tracebacks[-1] if tracebacks else {}
            emit_error = {
                "ok": status == "ok",
                "status": status,
                "elapsed": round(time.monotonic() - started, 4),
                "ename": last.get("ename") or (type(error).__name__ if error else None),
                "evalue": last.get("evalue") if error else None,
                "traceback": "\n".join(item["text"] for item in tracebacks),
                "definitions": sorted(user_names(self.shell) - before - RESERVED_NS_NAMES)[:100],
            }
            write_frame(self.proto_fd, {"t": "exec_end", "id": exec_id, **emit_error})
            emitted = True
        except BaseException as error:  # the daemon itself failed mid-cell; say so before anything else
            self.log.error(f"daemon error while running {exec_id}: {traceback.format_exc(limit=8)}")
            if not emitted:
                write_frame(
                    self.proto_fd,
                    {
                        "t": "exec_end",
                        "id": exec_id,
                        "ok": False,
                        "status": "interrupted" if isinstance(error, KeyboardInterrupt) else "error",
                        "elapsed": round(time.monotonic() - started, 4),
                        "ename": type(error).__name__,
                        "evalue": str(error),
                        "traceback": traceback.format_exc(limit=12),
                    },
                )
        finally:
            self._end(exec_id)

    def setvar(self, frame: dict) -> None:
        """Bind the full capture of a truncated exec to a global, so the next cell can slice it."""
        name = frame.get("name")
        if not isinstance(name, str) or not name.isidentifier():
            self.log.warn(f"setvar: not an identifier: {name!r}")
            return
        if "path" in frame:
            try:
                with open(frame["path"], encoding="utf-8", errors="replace") as handle:
                    value = handle.read()
            except OSError as error:
                self.log.warn(f"setvar: cannot read {frame['path']}: {error}")
                return
        else:
            value = frame.get("text")
            if not isinstance(value, str):
                self.log.warn("setvar: no path or text in frame")
                return
        self.shell.user_ns[name] = value
        self.log.debug(f"setvar {name} = {len(value)} chars")


async def serve(inbox: Inbox, runner: Runner, log: Log) -> int:
    while True:
        frame = await inbox.get()
        if frame is None:
            log.info("stdin closed; exiting")
            return 0

        kind = frame.get("t")
        if kind == "execute":
            await runner.run(frame)
        elif kind == "setvar":
            runner.setvar(frame)
        elif kind == "shutdown":
            log.info("shutdown requested; exiting")
            return 0
        elif kind == "interrupt":
            # A frame can only be read between cells, so the useful case is "interrupt the queued
            # work" — there is none. Interrupting a running cell is a SIGINT, sent by the host.
            log.debug("interrupt frame received while idle; nothing to interrupt")
        elif kind in ("_badjson", "_overlong"):
            log.error(f"malformed frame on stdin: {frame.get('detail') or frame.get('t')}")
        else:
            log.warn(f"unknown frame type: {kind!r}")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="replmode-daemon", description="pi-replmode IPython daemon")
    parser.add_argument("--channel", default="main", help="channel this daemon serves")
    parser.add_argument("--log", required=True, help="where to write daemon diagnostics")
    parser.add_argument("--cwd", default=None, help="working directory to report (informational)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    # ── The descriptor juggling. Do this before anything writes to stdout or stderr.
    proto_fd = os.dup(1)
    os.dup2(2, 1)
    log = Log(args.log, proto_fd)

    if args.cwd:
        try:
            os.chdir(args.cwd)
        except OSError as error:
            log.error(f"cannot chdir to {args.cwd}: {error}")

    try:
        import IPython  # noqa: F401  (imported to report the version, and to fail loudly here)
    except ImportError:
        log.error("IPython is not installed in this Python environment")
        write_frame(
            proto_fd,
            {"t": "fatal", "error": "IPython is not installed", "traceback": traceback.format_exc(limit=6)},
        )
        return 1

    started = time.monotonic()
    try:
        shell = create_shell(args.channel)
    except BaseException:
        log.error("failed to start the IPython shell")
        write_frame(proto_fd, {"t": "fatal", "error": "shell startup failed", "traceback": traceback.format_exc(limit=12)})
        return 1

    write_frame(
        proto_fd,
        {
            "t": "ready",
            "channel": args.channel,
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "cwd": os.getcwd(),
            "python": sys.version.split()[0],
            "ipython": IPython.__version__,
            "startup_ms": int((time.monotonic() - started) * 1000),
            "log": args.log,
        },
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    inbox = Inbox(0, loop)
    runner = Runner(shell, proto_fd, log, args.channel)

    exit_code = 0
    task = loop.create_task(serve(inbox, runner, log))
    try:
        while True:
            try:
                exit_code = loop.run_until_complete(task)
                break
            except KeyboardInterrupt:
                # A SIGINT that lands between cells (the host interrupted something that had already
                # finished, or an interrupt racing a cell boundary). The channel survives.
                log.debug("KeyboardInterrupt outside a cell; continuing")
                continue
            except BaseException:
                log.error("daemon crashed")
                write_frame(proto_fd, {"t": "fatal", "error": "daemon crashed", "traceback": traceback.format_exc(limit=12)})
                exit_code = 1
                break
    finally:
        inbox.close()

    return exit_code
