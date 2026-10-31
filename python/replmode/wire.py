"""The wire format.

Protocol frames are JSON objects, one per line, written by the daemon to the descriptor it saved
from the stdout it was started with. Everything else — every byte the user's code writes to fd 1 or
fd 2 — goes to the capture stream, which is the *stderr* the daemon was started with. The two
streams are separate pipes on the host side, so raw output can never corrupt a frame.

The capture stream is not structured, except for the boundary sentinels the daemon writes around
each exec. They are what lets the host say which bytes belong to which cell, and wait for the last
one before returning a result: frame delivery and capture delivery are independent pipes, so an
`exec_end` frame can overtake the cell's own output.
"""

from __future__ import annotations

import json
import os

#: Marks an exec boundary in the capture stream: NUL, record separator, tag, exec id, newline.
#: A false positive would need user code to write exactly this byte sequence to a text stream.
SENTINEL_PREFIX = b"\x00\x1ePIRB\x1e"
SENTINEL_SUFFIX = b"\n"


def sentinel(exec_id: str) -> bytes:
    """The boundary marker for one exec, written before the cell runs and after it finishes."""
    return SENTINEL_PREFIX + exec_id.encode("ascii") + SENTINEL_SUFFIX


def write_frame(fd: int, frame: dict) -> None:
    """Write one protocol frame. `fd` is the saved protocol descriptor, never 1 or 2."""
    data = (json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8")
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def decode_frame(line: bytes) -> dict:
    """Parse one frame. Raises ValueError on anything that is not a JSON object."""
    frame = json.loads(line)
    if not isinstance(frame, dict):
        raise ValueError(f"frame is not an object: {line[:120]!r}")
    return frame
