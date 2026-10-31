"""The daemon's event loop: read frames, run cells, keep the two output streams apart.

Startup order matters and is the whole trick:

    proto = dup(1)      # the protocol pipe, saved away
    dup2(2, 1)          # fd 1 now writes to the capture pipe like fd 2 does
    capture = dup(2)    # the daemon's own reference to the capture stream

From that point on, protocol frames go only to `proto`, and *everything* the user's code (or a
subprocess, or a C library) writes to fd 1 or fd 2 lands in the capture stream, in order, with no
Python-level buffering between them. The daemon's own diagnostics go to a log file and to `log`
frames — never to those descriptors. `capture` matters because fd 1 and fd 2 belong to the user's
code, which can close or redirect them: the daemon writes its boundary markers to its own reference
and repairs the public two at every exec boundary, so one cell wrecking its output cannot blind the
channel for good.

The loop is a raw asyncio loop, never `asyncio.run()`: asyncio's runner installs a SIGINT handler
that cannot reach a cell stuck inside synchronous code, so `asyncio.run` makes the cell
uninterruptible. A raw loop leaves CPython's default handler in place, SIGINT raises
KeyboardInterrupt inside the running cell, IPython reports it, and the shell is ready for the next
cell. That is what `bg_stop` and an aborted foreground call rely on.

A cell that is *waiting* rather than running bytecode is the other half: there the signal is raised
in the thread driving the loop, not in the coroutine, so the daemon catches it and hands it to the
cell task itself (see `Runner.interrupt_cell`). Without that, an interrupt would never reach
`await asyncio.sleep(20)`.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
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


class ProtocolGone(Exception):
    """The protocol pipe cannot be written: the host went away, or a cell closed the descriptor.

    A daemon that cannot answer is worse than a dead one — the host waits for a frame that can never
    arrive — so this ends the process instead of being logged and carried.
    """


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


def disposition_name(handler: Any) -> str:
    if handler is signal.SIG_IGN:
        return "SIG_IGN"
    if handler is signal.SIG_DFL:
        return "SIG_DFL"
    return getattr(handler, "__name__", None) or repr(handler)


def send_frame(log: Log, proto_fd: int, frame: dict) -> None:
    """Send a frame, and treat a broken protocol pipe as the end of the daemon."""
    try:
        write_frame(proto_fd, frame)
    except OSError as error:
        log.error(f"cannot write to the host ({type(error).__name__}: {error}); the channel is over")
        raise ProtocolGone(str(error)) from error


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
                # Anything a decoder can raise on hostile input — RecursionError from a deeply
                # nested document, not just ValueError — is a bad frame, not a crash. Letting it
                # escape here puts asyncio's traceback on the capture stream.
                try:
                    frame = decode_frame(line)
                except BaseException as error:
                    self.queue.put_nowait(
                        {
                            "t": "_badjson",
                            "detail": f"{type(error).__name__}: {error}",
                            "line": line[:200].decode("utf-8", "replace"),
                        }
                    )
                    continue
                self.queue.put_nowait(frame)

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

    def __init__(self, shell: Any, proto_fd: int, log: Log, channel: str, capture_fd: int) -> None:
        self.shell = shell
        self.proto_fd = proto_fd
        self.log = log
        self.channel = channel
        self.capture_fd = capture_fd
        # The cell task, so an interrupt can reach a cell that is parked on an `await`.
        self.cell_task: asyncio.Task | None = None
        self.interrupts = 0
        self.sigint_handler = signal.getsignal(signal.SIGINT)
        if self.sigint_handler is signal.SIG_IGN:
            self.log.warn("SIGINT is ignored in this process: cells in this channel cannot be interrupted")
        self._capture_broken = False

    # ── The capture stream ───────────────────────────────────────────────────

    def _capture(self, data: bytes) -> bool:
        """Write to the capture stream through the daemon's own descriptor.

        fd 2 is the capture pipe as well, but it is the *cell's* fd 2, and the cell may have closed or
        redirected it. A broken capture is the cell's problem, not the channel's: say so once and go
        on answering frames.
        """
        for fd in (self.capture_fd, 2, 1):
            try:
                view = memoryview(data)
                while view:
                    view = view[os.write(fd, view):]
                return True
            except OSError:
                continue
        if not self._capture_broken:
            self._capture_broken = True
            self.log.warn("the capture stream is not writable: this exec's output may be incomplete")
        return False

    def _capture_reference(self) -> os.stat_result | None:
        try:
            return os.fstat(self.capture_fd)
        except OSError:
            # Something closed our private descriptor too. If a public one is still the capture
            # stream, take a new reference from it rather than lose the channel's output.
            for fd in (2, 1):
                try:
                    self.capture_fd = os.dup(fd)
                    return os.fstat(self.capture_fd)
                except OSError:
                    continue
            return None

    def _restore_capture(self) -> None:
        """Point fd 1 and fd 2 back at the capture stream, and replace any stream object the cell closed."""
        reference = self._capture_reference()
        if reference is None:
            return
        broken: list[int] = []
        for fd in (1, 2):
            try:
                stat = os.fstat(fd)
            except OSError:
                broken.append(fd)
                continue
            if (stat.st_dev, stat.st_ino) != (reference.st_dev, reference.st_ino):
                broken.append(fd)
        for fd in broken:
            try:
                os.dup2(self.capture_fd, fd)
            except OSError as error:
                self.log.warn(f"cannot put fd {fd} back on the capture stream: {error}")
        if broken:
            self.log.info(f"restored fd {' and '.join(map(str, broken))} to the capture stream for this exec")

        replaced: list[str] = []
        for name in ("stdout", "stderr"):
            stream = getattr(sys, name, None)
            if stream is None or getattr(stream, "closed", False):
                replacement = self._new_stream(1 if name == "stdout" else 2)
                if replacement is not None:
                    setattr(sys, name, replacement)
                    replaced.append(name)
        # IPython writes reprs through the streams it was given at startup, so follow the replacement.
        if replaced:
            self.log.info(f"replaced sys.{', sys.'.join(replaced)}: a cell had closed it")
            for attribute, name in (("user_output", "stdout"), ("user_err", "stderr")):
                current = getattr(self.shell, attribute, None)
                if current is None or getattr(current, "closed", False):
                    setattr(self.shell, attribute, getattr(sys, name))

    @staticmethod
    def _new_stream(fd: int) -> io.TextIOWrapper | None:
        try:
            return io.TextIOWrapper(io.FileIO(fd, "w", closefd=False), encoding="utf-8", errors="backslashreplace", line_buffering=True)
        except OSError:
            return None

    def _restore_interrupt_handler(self) -> None:
        """Undo a cell that replaced the SIGINT handler, so it cannot un-arm the whole channel.

        The mask is normalized at every boundary (see `deferred_interrupt`); this is the disposition.
        It does not make the *cell that changed it* interruptible — that cell asked for this — it stops
        that cell from taking interruptibility away from every later one.
        """
        current = signal.getsignal(signal.SIGINT)
        if current == self.sigint_handler:
            return
        try:
            signal.signal(signal.SIGINT, self.sigint_handler)
        except (OSError, ValueError) as error:
            self.log.warn(f"cannot restore the SIGINT handler: {error}")
            return
        self.log.warn(f"a cell left SIGINT on {disposition_name(current)}; restored {disposition_name(self.sigint_handler)}")

    def _begin(self, exec_id: str) -> None:
        self._capture_broken = False
        self.interrupts = 0
        with deferred_interrupt():
            self._restore_capture()
            self._restore_interrupt_handler()
            flush_streams()
            self._capture(sentinel(exec_id))
        self.shell.reset_tracebacks()

    def _end(self, exec_id: str) -> None:
        with deferred_interrupt():
            # Flush into whatever the cell pointed its streams at, then repair them, then flush again:
            # that way the cell's own output stays where the cell sent it, and the closing marker
            # still lands even if the cell closed the descriptors.
            flush_streams()
            self._restore_capture()
            flush_streams()
            self._capture(sentinel(exec_id))

    # ── Cells ────────────────────────────────────────────────────────────────

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

            # The cell runs as a task the Runner holds. A SIGINT that lands while the cell is
            # suspended is raised in the loop, not in the coroutine, and `interrupt_cell` is what
            # delivers it to the cell that is actually waiting.
            self.cell_task = asyncio.ensure_future(
                self.shell.run_cell_async(
                    code,
                    transformed_cell=transformed,
                    preprocessing_exc_tuple=preprocessing_exc,
                    store_history=True,
                )
            )
            try:
                result = await self.cell_task
            finally:
                self.cell_task = None

            error = result.error_in_exec or result.error_before_exec
            delivered_as_cancel = isinstance(error, asyncio.CancelledError) and self.interrupts > 0
            if error is None:
                status = "ok"
            elif isinstance(error, KeyboardInterrupt) or delivered_as_cancel:
                status = "interrupted"
            else:
                status = "error"
            if delivered_as_cancel:
                self.log.info(f"the interrupt for {exec_id} reached the cell as a CancelledError")

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
            send_frame(self.log, self.proto_fd, {"t": "exec_end", "id": exec_id, **emit_error})
            emitted = True
        except ProtocolGone:
            raise
        except BaseException as error:  # the daemon itself failed mid-cell; say so before anything else
            self.log.error(f"daemon error while running {exec_id}: {traceback.format_exc(limit=8)}")
            if not emitted:
                send_frame(
                    self.log,
                    self.proto_fd,
                    {
                        "t": "exec_end",
                        "id": exec_id,
                        "ok": False,
                        "status": "interrupted" if isinstance(error, (KeyboardInterrupt, asyncio.CancelledError)) else "error",
                        "elapsed": round(time.monotonic() - started, 4),
                        "ename": type(error).__name__,
                        "evalue": str(error),
                        "traceback": traceback.format_exc(limit=12),
                    },
                )
        finally:
            self.cell_task = None
            self._end(exec_id)

    def interrupt_cell(self) -> str:
        """Put an interrupt into the cell that is currently waiting. Returns what it took to do it.

        `asyncio.Task` has no `throw`, so the way to raise an exception *inside* a parked coroutine is
        to put it on the future the coroutine is waiting for: the yield bubbles up through `await`ed
        coroutines, so the task's own waiter is usually the leaf. If that is not possible — the cell
        is parked on something we should not set an exception on, or on an executor — escalate to a
        cancellation, which `run` reports as an interrupt.
        """
        task = self.cell_task
        if task is None or task.done():
            return "none"
        self.interrupts += 1

        # A task we descend into cannot take the exception itself; follow it to its own waiter.
        waiter: Any = getattr(task, "_fut_waiter", None)
        for _ in range(16):
            if isinstance(waiter, asyncio.Task):
                waiter = getattr(waiter, "_fut_waiter", None)
                continue
            break
        if self.interrupts == 1 and isinstance(waiter, asyncio.Future) and not waiter.done():
            try:
                waiter.set_exception(KeyboardInterrupt())
                self.log.debug("interrupt delivered to the future the running cell is parked on")
                return "waiter"
            except (RuntimeError, TypeError):
                pass
        task.cancel()
        return "cancel"

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
        # One frame must never be able to kill the loop: a handler that raises leaves the daemon alive
        # but deaf, which from the host looks exactly like a cell that runs forever.
        try:
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
        except asyncio.CancelledError:
            raise
        except ProtocolGone:
            raise
        except BaseException:
            log.error(f"the {kind!r} frame handler raised: {traceback.format_exc(limit=10)}")


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
    capture_fd = os.dup(2)
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
        send_frame(log, proto_fd, {"t": "fatal", "error": "IPython is not installed", "traceback": traceback.format_exc(limit=6)})
        return 1

    started = time.monotonic()
    try:
        shell = create_shell(args.channel)
    except BaseException:
        log.error("failed to start the IPython shell")
        send_frame(log, proto_fd, {"t": "fatal", "error": "shell startup failed", "traceback": traceback.format_exc(limit=12)})
        return 1

    try:
        send_frame(
            log,
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
    except ProtocolGone:
        return 1

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    # Anything asyncio reports about a callback belongs in the daemon's log. Its default handler writes
    # to stderr, which here is the cell's capture stream.
    loop.set_exception_handler(lambda _loop, context: log.error(f"asyncio: {context.get('message')}: {context.get('exception') or ''}"))
    inbox = Inbox(0, loop)
    runner = Runner(shell, proto_fd, log, args.channel, capture_fd)

    exit_code = 0
    task = loop.create_task(serve(inbox, runner, log))
    try:
        while True:
            try:
                exit_code = loop.run_until_complete(task)
                break
            except KeyboardInterrupt:
                # Either a SIGINT that landed while the cell was parked on an await, or one that raced
                # a cell boundary. The first has to reach the cell; the second is nothing to do.
                how = runner.interrupt_cell()
                if how != "none":
                    log.debug(f"KeyboardInterrupt handed to the running cell ({how})")
                    continue
                if task.done():
                    # The frame loop is gone; there is nothing left to read a frame. Say so and leave,
                    # rather than sit alive and deaf on a channel the host cannot use.
                    reason = task.exception() if not task.cancelled() else "cancelled"
                    log.error(f"the frame loop ended ({reason!r}); the channel is over")
                    send_frame(log, proto_fd, {"t": "fatal", "error": f"the frame loop ended: {reason!r}"})
                    exit_code = 1
                    break
                log.debug("KeyboardInterrupt outside a cell; continuing")
                continue
            except ProtocolGone:
                exit_code = 1
                break
            except BaseException:
                log.error("daemon crashed")
                try:
                    write_frame(proto_fd, {"t": "fatal", "error": "daemon crashed", "traceback": traceback.format_exc(limit=12)})
                except OSError:
                    pass
                exit_code = 1
                break
    finally:
        inbox.close()

    return exit_code
