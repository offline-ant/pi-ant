/**
 * /tmux-fork and tmux-fork — fork the current pi session into a new tmux pane.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionManager, type ExtensionAPI, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const TMUX_SCRIPT = path.resolve(__dirname, "../bin/pi-tmux");
const FORK_COMMAND_TIMEOUT_MS = 120_000;
const FORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PI_FORK = process.env.PI_FORK === "true";
const FORK_BLOCK_MESSAGE = "You are the fork, this tool is blocked. Do what you were told.";
const FORK_SYSTEM_PROMPT = [
  "You are running in a forked/sub-agent pi process, not the original controlling session.",
  "Do not call tmux-fork or tempfork from this process; those tools are blocked here.",
  "Complete only the task you were given and report the result back.",
].join("\n");

const tmuxForkParams = Type.Object({
  name: Type.String({ description: "Tmux lock/window name for the forked pi agent" }),
  folder: Type.Optional(
    Type.String({ description: "Working directory for the forked session. Defaults to the current working directory." }),
  ),
  prompt: Type.Optional(
    Type.String({ description: "Optional initial prompt for the forked agent to start working on immediately." }),
  ),
  piArgs: Type.Optional(
    Type.String({ description: "Additional pi CLI arguments, such as --provider/--model overrides." }),
  ),
  contextAlertPercent: Type.Optional(
    Type.Number({
      description:
        "Context usage percentage (1-100) at which to release a <name>:context lock in the forked pane.",
    }),
  ),
});
export type TmuxForkInput = Static<typeof tmuxForkParams>;

type PendingFork = TmuxForkInput;

const pendingForks = new Map<string, PendingFork>();

function validateForkName(name: string): string | undefined {
  if (!name) return "Usage: /tmux-fork <name> [folder] [--context-alert <percent>] [--pi-args <args>] [-- <prompt>]";
  if (/\s/.test(name)) return "tmux-fork name must not contain whitespace";
  if (!FORK_NAME_PATTERN.test(name)) {
    return "tmux-fork name must start with a letter or number and contain only letters, numbers, '.', '_', or '-'";
  }
  if (name === "." || name === ".." || name.includes("..")) {
    return "tmux-fork name must not be '.' or contain '..'";
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputText(stdout: string, stderr: string): string {
  const text = stdout.trim() || stderr.trim();
  return text.length > 0 ? text : "(no output)";
}

function flushSessionFile(sessionManager: SessionManager, sessionFile: string): void {
  const header = sessionManager.getHeader();
  if (!header) {
    throw new Error("New session has no header");
  }

  const entries: Array<SessionHeader | SessionEntry> = [header, ...sessionManager.getEntries()];
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
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

function parseTmuxForkArgs(args: string): TmuxForkInput {
  const separator = args.includes(" -- ") ? args.indexOf(" -- ") : -1;
  const optionsText = separator === -1 ? args : args.slice(0, separator);
  const prompt = separator === -1 ? undefined : args.slice(separator + 4).trim();
  const tokens = parseCommandLine(optionsText.trim());
  const name = tokens.shift() ?? "";
  let folder: string | undefined;
  let piArgs: string | undefined;
  let contextAlertPercent: number | undefined;

  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === undefined) break;
    if (token === "--context-alert") {
      const value = tokens.shift();
      if (value === undefined) throw new Error("--context-alert requires a percentage");
      contextAlertPercent = Number(value);
      continue;
    }
    if (token.startsWith("--context-alert=")) {
      contextAlertPercent = Number(token.slice("--context-alert=".length));
      continue;
    }
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

  return { name, folder, piArgs, contextAlertPercent, prompt };
}

function validateInput(input: TmuxForkInput): string | undefined {
  const nameError = validateForkName(input.name.trim());
  if (nameError) return nameError;
  if (input.contextAlertPercent !== undefined) {
    if (!Number.isFinite(input.contextAlertPercent) || input.contextAlertPercent < 1 || input.contextAlertPercent > 100) {
      return "contextAlertPercent must be a number from 1 to 100";
    }
  }
  return undefined;
}

async function runTmux(pi: ExtensionAPI, args: string[], signal?: AbortSignal) {
  return pi.exec("bash", [TMUX_SCRIPT, ...args], { signal, timeout: FORK_COMMAND_TIMEOUT_MS });
}

function writePromptFile(prompt: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-fork-"));
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, prompt, "utf8");
  return file;
}

async function forkIntoTmux(pi: ExtensionAPI, input: TmuxForkInput, cwd: string, sessionManager: SessionManager, signal?: AbortSignal) {
  const validationError = validateInput(input);
  if (validationError) {
    throw new Error(validationError);
  }

  const targetCwd = path.resolve(cwd, input.folder ?? ".");
  const parentSession = sessionManager.getSessionFile();
  if (!parentSession || !fs.existsSync(parentSession)) {
    throw new Error("Current session is not persisted; cannot fork into tmux");
  }
  if (!fs.existsSync(targetCwd) || !fs.statSync(targetCwd).isDirectory()) {
    throw new Error(`Target folder does not exist or is not a directory: ${targetCwd}`);
  }

  const forked = SessionManager.forkFrom(parentSession, targetCwd);
  const sessionFile = forked.getSessionFile();
  if (!sessionFile) {
    throw new Error("Could not create a persistent fork session");
  }

  const promptFile = input.prompt && input.prompt.trim().length > 0 ? writePromptFile(input.prompt) : undefined;
  forked.appendCustomEntry("tmux-fork", {
    name: input.name,
    sourceCwd: cwd,
    targetCwd,
    parentSession,
    sessionFile,
    promptFile,
  });
  flushSessionFile(forked, sessionFile);

  const args = ["session-agent", input.name.trim(), targetCwd, sessionFile, "--status-only"];
  if (input.contextAlertPercent !== undefined) {
    args.push("--context-alert", String(input.contextAlertPercent));
  }
  if (input.piArgs?.trim()) {
    args.push("--pi-args", input.piArgs.trim());
  }
  if (promptFile) {
    args.push("--prompt-file", promptFile);
  }

  const result = await runTmux(pi, args, signal);
  const text = outputText(result.stdout, result.stderr);
  if (result.code !== 0) {
    throw new Error(text);
  }

  return { text, sessionFile, targetCwd };
}

function createPendingId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    if (!PI_FORK) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${FORK_SYSTEM_PROMPT}` };
  });

  pi.registerCommand("tmux-fork", {
    description:
      "Fork the current session into a new pi agent in tmux. Usage: /tmux-fork <name> [folder] [--context-alert <percent>] [--pi-args <args>] [-- <prompt>]",
    handler: async (args, ctx) => {
      if (PI_FORK) {
        ctx.ui.notify(FORK_BLOCK_MESSAGE, "warning");
        return;
      }

      let input: TmuxForkInput;
      try {
        input = parseTmuxForkArgs(args);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }

      const validationError = validateInput(input);
      if (validationError) {
        ctx.ui.notify(validationError, "error");
        return;
      }

      await ctx.waitForIdle();

      try {
        const result = await forkIntoTmux(pi, input, ctx.cwd, ctx.sessionManager);
        ctx.ui.notify(`${result.text}\n\nForked session: ${result.sessionFile}`, "info");
      } catch (error) {
        ctx.ui.notify(`tmux-fork failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("tmux-fork-run", {
    description: "Internal follow-up command used by the tmux-fork tool.",
    handler: async (args, ctx) => {
      if (PI_FORK) {
        ctx.ui.notify(FORK_BLOCK_MESSAGE, "warning");
        return;
      }

      const id = args.trim();
      const input = pendingForks.get(id);
      if (!input) {
        ctx.ui.notify(`No pending tmux-fork request found for ${id}`, "error");
        return;
      }
      pendingForks.delete(id);
      await ctx.waitForIdle();

      try {
        const result = await forkIntoTmux(pi, input, ctx.cwd, ctx.sessionManager);
        ctx.ui.notify(`${result.text}\n\nForked session: ${result.sessionFile}`, "info");
      } catch (error) {
        ctx.ui.notify(`tmux-fork failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "tmux-fork",
    label: "Tmux Fork",
    description:
      "Fork the current pi session into a new interactive pi agent in a tmux pane. Queues the fork until the current turn is fully persisted.",
    promptSnippet: "Fork the current pi session into a new interactive pi agent in tmux",
    promptGuidelines: [
      "Use tmux-fork only when the user explicitly asks to continue, delegate, or fork the current session into another tmux pane.",
      "Use tmux-fork.prompt when the forked agent should start work immediately; otherwise omit it to leave the forked pane idle.",
    ],
    parameters: tmuxForkParams,
    async execute(_toolCallId, params) {
      if (PI_FORK) {
        return {
          content: [{ type: "text", text: FORK_BLOCK_MESSAGE }],
          details: { blocked: true, reason: "PI_FORK=true" },
          terminate: true,
        };
      }

      const validationError = validateInput(params);
      if (validationError) {
        throw new Error(validationError);
      }

      const id = createPendingId();
      pendingForks.set(id, params);
      pi.sendUserMessage(`/tmux-fork-run ${id}`, { deliverAs: "followUp" });

      return {
        content: [{ type: "text", text: `Queued tmux-fork '${params.name}' to run after the current turn completes.` }],
        details: { id, params },
        terminate: true,
      };
    },
  });
}
