/**
 * /herdr-fork — fork the current pi session into a new Herdr tab.
 */

import * as fs from "node:fs";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeHerdrAgent, flushSessionFile, modelCliArgs, promptHerdrAgent, resolveCwd, startHerdrPiAgent, validateHerdrAgentName } from "./herdr-helpers.ts";
const IS_HERDR_FORK = process.env.PI_HERDR_FORK === "true";
const FORK_SYSTEM_PROMPT =
  "You are running in an interactive Herdr fork, not the original controlling session. Continue assisting the user in this forked session.";

interface HerdrForkInput {
  name: string;
  folder?: string;
  prompt?: string;
}

interface SessionFileProvider {
  getSessionFile(): string | undefined;
}

function validateForkName(name: string): string | undefined {
  if (!name) return "Usage: /herdr-fork <name> [folder] [-- <prompt>]";
  try {
    validateHerdrAgentName(name);
    return undefined;
  } catch {
    return "herdr-fork name must start with a lowercase letter, contain only lowercase letters, numbers, '_' or '-', and be at most 32 characters";
  }
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

  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === undefined) break;
    if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    if (folder !== undefined) throw new Error(`Unexpected extra argument: ${token}`);
    folder = token;
  }

  return { name, folder, prompt };
}

function validateInput(input: HerdrForkInput): string | undefined {
  return validateForkName(input.name.trim());
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

  const prompt = input.prompt?.trim() || undefined;
  forked.appendCustomEntry("pi-herdr:fork", {
    name,
    sourceCwd: cwd,
    targetCwd,
    parentSession,
    sessionFile,
    prompt,
  });
  flushSessionFile(forked, sessionFile);

  const started = await startHerdrPiAgent(pi, {
    name,
    cwd: targetCwd,
    sessionFile,
    piArgs,
    env: { PI_HERDR_FORK: "true" },
  }, signal);
  try {
    if (prompt) await promptHerdrAgent(pi, started.agentName, prompt, signal);
  } catch (error) {
    await closeHerdrAgent(pi, started.agentName, started.paneId).catch(() => undefined);
    throw error;
  }

  return [
    `Started Herdr fork '${name}'.`,
    `Agent: ${started.agentName}`,
    `Tab: ${started.tabId ?? "unknown"}`,
    `Pane: ${started.paneId}`,
    `Cwd: ${targetCwd}`,
    `Forked session: ${sessionFile}`,
  ].join("\n");
}

export default function herdrForkExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (!IS_HERDR_FORK) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${FORK_SYSTEM_PROMPT}` };
  });

  pi.registerCommand("herdr-fork", {
    description: "Fork the current session into a new Pi agent in a Herdr tab. Usage: /herdr-fork <name> [folder] [-- <prompt>]",
    handler: async (args, ctx) => {
      let input: HerdrForkInput;
      try {
        input = parseHerdrForkArgs(args);
        const validationError = validateInput(input);
        if (validationError) {
          ctx.ui.notify(validationError, "error");
          return;
        }
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }

      await ctx.waitForIdle();
      try {
        const piArgs = modelCliArgs(ctx.model, pi.getThinkingLevel());
        const text = await forkIntoHerdr(pi, input, ctx.cwd, ctx.sessionManager, piArgs);
        ctx.ui.notify(text, "info");
      } catch (error) {
        ctx.ui.notify(`herdr-fork failed: ${errorMessage(error)}`, "error");
      }
    },
  });
}
