/**
 * Load the extension the way pi loads it, without a model.
 *
 * `loadExtension` points `PI_CODING_AGENT_DIR` at a temp directory *before* importing, so every path
 * the extension derives from `getAgentDir()` — exec logs, daemon logs, history — is inside the test.
 * The factory gets a recording `ExtensionAPI`: anything the extension reaches for that this harness
 * does not implement throws with instructions, so a new `pi.*` dependency cannot sneak past the tests.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

export interface RecordedCall {
  prop: string;
  args: unknown[];
}

export interface LoadedExtension {
  api: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  /** Every `pi.*` member the extension touched, in order. */
  calls: RecordedCall[];
  /** Notifications the extension pushed at the user. */
  notified: { message: string; kind?: string }[];
  agentDir: string;
  cwd: string;
  callTool(name: string, params: unknown, options?: CallOptions): Promise<any>;
  /** Deliver a lifecycle event to every handler registered for its type. */
  emit(event: { type: string; [key: string]: unknown }, ctx?: Partial<Record<string, unknown>>): Promise<unknown[]>;
  dispose(): Promise<void> | void;
}

export interface CallOptions {
  signal?: AbortSignal;
  onUpdate?: (partial: unknown) => void;
  context?: Partial<Record<string, unknown>>;
  toolCallId?: string;
}

export interface LoadOptions {
  entry?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Reuse an agent dir across two loads: same on-disk state, new runtime, i.e. a reload. */
  agentDir?: string;
}

export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  outputSchema?: unknown;
  executionMode?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    ctx: ExtensionToolContext,
  ) => Promise<any>;
}

export async function loadExtension(options: LoadOptions = {}): Promise<LoadedExtension> {
  const agentDir = options.agentDir ? resolve(options.agentDir) : mkdtempSync(join(tmpdir(), "replmode-agent-"));
  const ownsAgentDir = options.agentDir === undefined;
  const cwd = options.cwd ? resolve(options.cwd) : mkdtempSync(join(tmpdir(), "replmode-cwd-"));

  const savedEnv: Record<string, string | undefined> = {};
  for (const key of ["PI_CODING_AGENT_DIR", "PI_REPLMODE_MAX_CHANNELS", ...Object.keys(options.env ?? {})]) {
    savedEnv[key] = process.env[key];
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const calls: RecordedCall[] = [];
  const notified: { message: string; kind?: string }[] = [];

  const api = new Proxy({} as ExtensionAPI, {
    get(_target, member: string) {
      calls.push({ prop: member, args: [] });
      switch (member) {
        case "registerTool":
          return (tool: ToolDefinition) => {
            if (tools.has(tool.name)) throw new Error(`the extension registered "${tool.name}" twice`);
            tools.set(tool.name, tool);
          };
        case "on":
          return (event: string, handler: (event: any, ctx: any) => unknown) => {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
            return () => {
              handlers.set(
                event,
                list.filter((entry) => entry !== handler),
              );
            };
          };
        default:
          throw new Error(
            `the extension used pi.${member}, which test/helpers/extension.ts does not implement. ` +
              "Add it to the harness so tests keep exercising the real code path.",
          );
      }
    },
    has() {
      return true;
    },
  });

  const entry = options.entry ?? resolve(repoRoot, "src/index.ts");
  const module = await import(pathToFileURL(entry).href);
  const factory = module.default ?? module;
  await factory(api);

  function makeContext(overrides: Partial<Record<string, unknown>> = {}): ExtensionToolContext {
    const context = {
      mode: "print",
      hasUI: false,
      ui: {
        notify: (message: string, kind?: string) => notified.push({ message, kind }),
        select: async () => undefined,
        confirm: async () => true,
        input: async () => undefined,
      },
      sessionManager: {
        getSessionId: () => "test-session",
        getSessionFile: () => join(agentDir, "sessions", "test-session.jsonl"),
        getEntries: () => [],
      },
      modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
      model: undefined,
      scopedModels: [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      signal: undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      getSystemPrompt: () => "",
      getSystemPromptOptions: () => ({}),
      tools: [],
      executeTool: async () => {
        throw new Error("executeTool is not available in tests");
      },
      cwd,
      ...overrides,
    };
    return context as unknown as ExtensionToolContext;
  }

  return {
    api,
    tools,
    handlers,
    calls,
    notified,
    agentDir,
    cwd,
    async callTool(name, params, callOptions = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool "${name}" is not registered; registered: ${[...tools.keys()].join(", ") || "none"}`);
      return tool.execute(
        callOptions.toolCallId ?? `call-${name}`,
        params,
        callOptions.signal,
        callOptions.onUpdate,
        makeContext(callOptions.context),
      );
    },
    async emit(event, ctxOverrides) {
      const list = handlers.get(event.type) ?? [];
      const ctx = makeContext(ctxOverrides);
      const results: unknown[] = [];
      for (const handler of list) results.push(await handler(event, ctx));
      return results;
    },
    dispose() {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (ownsAgentDir) rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

export const repoRoot = resolve(import.meta.dirname, "..", "..");

export function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

export function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  // A signalled child stays in the process table until its parent reaps it, and signal 0 succeeds
  // on a zombie, so read the state out of /proc rather than trusting the signal.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z";
  } catch {
    return true;
  }
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function makeTempDir(prefix = "replmode-"): { path: string; dispose(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}
