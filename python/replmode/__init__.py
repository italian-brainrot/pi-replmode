"""The pi-replmode daemon: one IPython shell, driven by JSON lines on stdin/stdout.

One daemon process serves one pi-replmode channel. It is deliberately single-threaded: IPython runs
on the main thread inside a raw asyncio event loop, which is what makes SIGINT interrupt a running
cell without killing the process (see docs/DESIGN.md, "Validated facts").
"""

__version__ = "0.1.0"
