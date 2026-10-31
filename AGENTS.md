# pi-replmode

This is an execution feature for Pi coding agent where the model interacts with the environment via a stateful IPython REPL. This is similar to codemode, but allows the model to define it's own tools as python functions. This project is mostly being developed by you (the AI), and your own tools in Pi will eventually be replaced with this project's.

## Coding guide for AI agents

- You can edit everything except this file (AGENTS.md), this file is written by the user.
- Everything else in this repo was written by you in previous sessions, and you have full control over all code, dependencies, tooling, style, instructions, etc.
- Instructions other than this file are not necessarily authoritative (may be outdated or written by older and less capable models). You can revise them if you see fit.
- Write in your normal style, don't try to explicitly mimic existing style, this can lead to style collapse.
- You will keep working on this repo in future sessions, so ensure maintainability.
- You should be very proactive with maintaining this repo, if you encounter a difficulty, make sure to improve the code or the tooling so that future sessions will not encounter it. This includes improving logging, tests, development documentation, and setting up development tools. It is also completely acceptable to add and change dependencies as well do big rewrites if necessary.
- You are also responsible for handling git, push your changes to github when you are done.
- Prompts and tool description should generally be short, concise, and avoid unnecessary instructions, to give the model more freedom in how it can use them.

## Pi tools

### run

Execute code in stateful IPython REPL. This is how agent reads, edits, writes files, executes commands, etc. This is the replacement for `bash` tool so it has full permissions.

Args:

- code (str) - code to send to REPL. Standard REPL semantics - typing an expression at the end is shorthand for print(repr(expression)). Top-level await supported by ipython.
- timeout (int) = 60 - timeout in seconds, after timeout, execution moves to background with output streamed to a temporary file, and returns id.
- channel (str) = "main" - isolated REPL instance, auto-created if doesn't exist. Running commands in REPL which currently has background command running is not allowed. Multiple channels can be used to work on different tasks concurrently.

REPL is stateful - future calls can reuse defined variables.

Output limit 50,000 characters. If output exceeds limit, it is truncated, and full output is saved to a variable with nonce name.

### bg_wait

Wait for ANY background task to finish. This also lists all background tasks for this session and their status.

Args:

- timeout (int) = 600  - timeout in seconds

Background task handling is similar to `/home/qq/distrobox/ubuntu/Projects/my-pi-extensions/packages/pi-bg-tasks`.

## REPL tools

REPL has `pi` namespace pre-imported with special tools:

### read_image

Reads an image. Allows multimodal models to natively read images. When the tool executes and successfully loads an image, current text content stops (if exists), image content is appened, further `repl` output is passed to another text content, so with a single call the `run` tool returns at most three content elements, one of which is an image, and more if `read_image` is called multiple times.

Args:
    image (np.ndarray | PIL.Image.Image | str | os.PathLike):
        Path to image, PIL image or a numpy array.
        For numpy array, image format: (H, W, C), (C, H, W) or (H, W); (H, W, C) + warn when ambiguous.
        If numpy array dtype is float, assume value range (0, 1), warn if clamping.
    max_size (int):
        If larger image side is bigger, resize the image. Defaults to 2000.

### ask

Ask user question, or ask them to perform an action that AI can't perform (such as using GUI).

Args:
    question (str): Text of the question.
    choices (Sequence[str]): List of choices, can be empty.
    allow_manual (bool): Whether to add additional choice to type the answer manually. Defaults to True.

Returns:
    str: The answer

### run_subagent

Run a subagent. Uses same model as current session.

Args:
    prompt (str): Prompt to send to subagent.

Returns:
    str: Final message that subagent returns.

## REPL env

Env comes with preinstalled packages:

- httpx, librosa, matplotlib, numpy, opencv-python-headless, pandas, Pillow, Playwright, polars, pyyaml, requests, scikit-learn, scipy

On harness restart, all variables in the env may be lost. This is fine - in other harnesses tmp folder is lost on restart, agent can recreate it easily. Append a notification about this to the chat.

## Compatibility with other extensions

Unlike codemode, replmode is isolated and doesn't integrate tools from extensions and MCP servers.
