"""Spike 2: SIGINT interrupt of a running cell + custom display hook for images."""
import asyncio, json, os, signal, sys, threading

proto_w = os.dup(1)

def emit(obj):
    os.write(proto_w, (json.dumps(obj) + "\n").encode())

from IPython.core.interactiveshell import InteractiveShell
from IPython.core.interactiveshell import InteractiveShell as IS

shell = IS.instance()
shell.colors = "NoColor"
shell.displayhook.executing = False
shell.display_formatter.formats = ["text/plain", "image/png"]

class Pic:
    def _repr_png_(self):
        return "aGVsbG8="
    def __repr__(self):
        return "Pic()"

async def run(code):
    tc = shell.transform_cell(code)
    res = await shell.run_cell_async(code, transformed_cell=tc, store_history=True)
    err = res.error_in_exec or res.error_before_exec
    return {"success": res.success, "err": repr(err) if err else None}

async def main():
    emit({"msg": "before"})
    # interrupt helper: send SIGINT to ourselves after 1s
    def later():
        import time; time.sleep(1.0); os.kill(os.getpid(), signal.SIGINT)
    threading.Thread(target=later, daemon=True).start()
    emit(await run("import time\nwhile True:\n    time.sleep(0.1)"))
    emit({"msg": "after interrupt"})
    emit(await run("1+1"))
    # formatters: what does the formatter chain give us for image objects?
    fmt = shell.display_formatter.format(Pic(), include=("text/plain", "image/png"))
    emit({"fmt_result": [str(x) for x in fmt]})
    emit({"formatters": {k: type(v).__name__ for k, v in shell.display_formatter.formatters.items()}})

loop = asyncio.new_event_loop()
try:
    loop.run_until_complete(main())
except BaseException:
    import traceback
    os.write(proto_w, b"DAEMON ERROR:\n" + traceback.format_exc().encode())

# Run: uv venv /tmp/ipyenv && VIRTUAL_ENV=/tmp/ipyenv uv pip install ipython pillow numpy
#      /tmp/ipyenv/bin/python spikes/interrupt-and-formatters.py
