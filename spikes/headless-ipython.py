"""Throwaway spike: drive IPython headlessly, capture output, images, magics, await."""
import asyncio, io, json, os, sys, types

# ---- fd-level capture: move protocol to a dup'd fd, point 1/2 at the capture pipe (here: a buffer)
cap_r, cap_w = os.pipe()
proto_w = os.dup(1)
os.dup2(cap_w, 1)
os.dup2(cap_w, 2)

from IPython.core.interactiveshell import InteractiveShell
from IPython.core.displayhook import DisplayHook

cfg = {}
shell = InteractiveShell.instance(
    display_pub=None,
)
shell.interactive = False
shell.displayhook.executing = False
shell.display_formatter.formats = [
    "text/plain", "image/png", "image/jpeg", "image/svg+xml", "text/html",
]

def emit(fd, obj):
    data = (json.dumps(obj) + "\n").encode()
    os.write(fd, data)

async def run(code):
    tc = shell.transform_cell(code)
    res = await shell.run_cell_async(code, transformed_cell=tc, store_history=True)
    err = res.error_in_exec or res.error_before_exec
    return {"success": res.success, "err": repr(err) if err else None, "result_type": type(getattr(res, "result", None)).__name__}

async def main():
    print("hello stdout")
    print("to stderr", file=sys.stderr)
    print(await run("x = 41"))
    print(await run("x + 1"))
    print(await run("os.system('echo from-subprocess-fd1')"))
    print(await run("!echo from-bang-magic"))
    print(await run("%who_ls"))
    print(await run("import asyncio\nawait asyncio.sleep(0.01)\n'awaited ok'"))
    print(await run("import numpy as np; np.arange(6)"))
    print(await run("class Pic:\n    def _repr_png_(self):\n        return 'aGVsbG8='\n    def __repr__(self): return 'Pic()'\nPic()"))
    print(await run("1/0"))
    print(await run("display('hi')"))
    print(await run("_oh"))
    # read captured bytes
    os.set_blocking(cap_r, False)
    await asyncio.sleep(0.2)
    buf = b""
    while True:
        try:
            chunk = os.read(cap_r, 65536)
        except BlockingIOError:
            break
        if not chunk:
            break
        buf += chunk
    os.write(proto_w, b"---CAPTURED---\n" + buf + b"\n---END---\n")


try:
    asyncio.run(main())
except BaseException:
    import traceback; os.write(proto_w, b"DAEMON ERROR:\n" + traceback.format_exc().encode())

# Run: uv venv /tmp/ipyenv && VIRTUAL_ENV=/tmp/ipyenv uv pip install ipython pillow numpy
#      /tmp/ipyenv/bin/python spikes/headless-ipython.py
