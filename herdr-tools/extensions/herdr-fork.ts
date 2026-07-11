/**
 * /herdr-fork — fork the current pi session into a new Herdr tab.
 */

import * as fs from "node:fs";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { flushSessionFile, resolveCwd, startHerdrPiPane, writePromptFile } from "./herdr-helpers.ts";
import { getSubagentModelCliArgs } from "./subagent-model-state.ts";

const FORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HERDR_FORK = process.env.PI_HERDR_FORK === "true";
const FORK_BLOCK_MESSAGE = "This process is already a Herdr fork; /herdr-fork is unavailable here.";
const FORK_SYSTEM_PROMPT = "This is a Herdr fork, not the controlling session. Complete the assigned task and report the result; do not invoke /herdr-fork.";

interface HerdrForkInput {
  name: string;
  folder?: string;
  prompt?: string;
  piArgs?: string;
}

interface SessionFileProvider {
  getSessionFile(): string | undefined;
}

interface PendingFork {
  input: HerdrForkInput;
  piArgs: string[];
}

const pendingForks = new Map<string, PendingFork>();

function validateForkName(name: string): string | undefined {
  if (!name) return "Usage: /herdr-fork <name> [folder] [--pi-args <args>] [-- <prompt>]";
  if (/\s/.test(name)) return "herdr-fork name must not contain whitespace";
  if (!FORK_NAME_PATTERN.test(name)) {
    return "herdr-fork name must start with a letter or number and contain only letters, numbers, '.', '_', or '-'";
  }
  if (name === "." || name === ".." || name.includes("..")) {
    return "herdr-fork name must not be '.' or contain '..'";
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === '"') && quote === undefined) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (/\s/.test(char) && quote === undefined) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (quote !== undefined) {
    throw new Error(`Unclosed ${quote} quote`);
  }
  if (current.length > 0) tokens.push(current);

  return tokens;
}

function parseHerdrForkArgs(args: string): HerdrForkInput {
  const separator = args.includes(" -- ") ? args.indexOf(" -- ") : -1;
  const optionsText = separator === -1 ? args : args.slice(0, separator);
  const prompt = separator === -1 ? undefined : args.slice(separator + 4).trim();
  const tokens = parseCommandLine(optionsText.trim());
  const name = tokens.shift() ?? "";
  let folder: string | undefined;
  let piArgs: string | undefined;

  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === undefined) break;
    if (token === "--pi-args") {
      const value = tokens.shift();
      if (value === undefined) throw new Error("--pi-args requires a value");
      piArgs = value;
      continue;
    }
    if (token.startsWith("--pi-args=")) {
      piArgs = token.slice("--pi-args=".length);
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (folder !== undefined) {
      throw new Error(`Unexpected extra argument: ${token}`);
    }
    folder = token;
  }

  return { name, folder, piArgs, prompt };
}

function validateInput(input: HerdrForkInput): string | undefined {
  return validateForkName(input.name.trim());
}

function resolvePiArgs(input: HerdrForkInput, defaultArgs: string[]): string[] {
  const explicit = input.piArgs?.trim();
  return explicit ? parseCommandLine(explicit) : defaultArgs;
}

function createPendingId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function forkIntoHerdr(
  pi: ExtensionAPI,
  input: HerdrForkInput,
  cwd: string,
  sessionManager: SessionFileProvider,
  piArgs: string[],
  signal?: AbortSignal,
): Promise<string> {
  const validationError = validateInput(input);
  if (validationError) {
    throw new Error(validationError);
  }

  const name = input.name.trim();
  const targetCwd = resolveCwd(cwd, input.folder);
  const parentSession = sessionManager.getSessionFile();
  if (!parentSession || !fs.existsSync(parentSession)) {
    throw new Error("Current session is not persisted; cannot fork into Herdr.");
  }

  const forked = SessionManager.forkFrom(parentSession, targetCwd);
  const sessionFile = forked.getSessionFile();
  if (!sessionFile) {
    throw new Error("Could not create a persistent fork session.");
  }

  const promptFile = input.prompt && input.prompt.trim().length > 0 ? writePromptFile(input.prompt) : undefined;
  forked.appendCustomEntry("pi-herdr:fork", {
    name,
    sourceCwd: cwd,
    targetCwd,
    parentSession,
    sessionFile,
    promptFile,
  });
  flushSessionFile(forked, sessionFile);

  const started = await startHerdrPiPane(pi, {
    name,
    cwd: targetCwd,
    sessionFile,
    piArgs,
    promptFile,
    placement: "tab",
    env: { PI_HERDR_FORK: "true" },
  }, signal);

  return [
    `Started Herdr fork '${name}'.`,
    `Tab: ${started.tabId ?? "unknown"}`,
    `Pane: ${started.paneId}`,
    `Cwd: ${targetCwd}`,
    `Forked session: ${sessionFile}`,
    promptFile ? `Prompt file: ${promptFile}` : undefined,
  ].filter(Boolean).join("\n");
}

async function runPendingFork(pi: ExtensionAPI, id: string, ctx: ExtensionCommandContext): Promise<void> {
  const pending = pendingForks.get(id);
  if (!pending) {
    ctx.ui.notify(`No pending herdr-fork request found for ${id}`, "error");
    return;
  }
  pendingForks.delete(id);
  await ctx.waitForIdle();

  try {
    const text = await forkIntoHerdr(pi, pending.input, ctx.cwd, ctx.sessionManager, pending.piArgs);
    ctx.ui.notify(text, "info");
  } catch (error) {
    ctx.ui.notify(`herdr-fork failed: ${errorMessage(error)}`, "error");
  }
}

export default function herdrForkExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (!HERDR_FORK) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${FORK_SYSTEM_PROMPT}` };
  });

  pi.registerCommand("herdr-fork", {
    description:
      "Fork the current session into a new pi agent in a Herdr tab. Usage: /herdr-fork <name> [folder] [--pi-args <args>] [-- <prompt>]",
    handler: async (args, ctx) => {
      if (HERDR_FORK) {
        ctx.ui.notify(FORK_BLOCK_MESSAGE, "warning");
        return;
      }

      let input: HerdrForkInput;
      let piArgs: string[];
      try {
        input = parseHerdrForkArgs(args);
        const validationError = validateInput(input);
        if (validationError) {
          ctx.ui.notify(validationError, "error");
          return;
        }
        piArgs = resolvePiArgs(input, getSubagentModelCliArgs(ctx));
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }

      const id = createPendingId();
      pendingForks.set(id, { input, piArgs });
      await runPendingFork(pi, id, ctx);
    },
  });

  pi.registerCommand("herdr-fork-run", {
    description: "Internal follow-up command for queued Herdr forks.",
    handler: async (args, ctx) => {
      if (HERDR_FORK) {
        ctx.ui.notify(FORK_BLOCK_MESSAGE, "warning");
        return;
      }

      await runPendingFork(pi, args.trim(), ctx);
    },
  });
}
