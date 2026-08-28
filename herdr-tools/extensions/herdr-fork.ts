/**
 * /herdr-fork — fork the current pi session into a sibling Herdr pane.
 */

import * as fs from "node:fs";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  agentExists,
  closeHerdrAgent,
  flushSessionFile,
  modelCliArgs,
  promptHerdrAgent,
  resolveCwd,
  startHerdrPiAgentInSiblingPane,
  validateHerdrAgentName,
} from "./herdr-helpers.ts";
const IS_HERDR_FORK = process.env.PI_HERDR_FORK === "true";
const FORK_SYSTEM_PROMPT =
  "You are running in an interactive Herdr fork, not the original controlling session. Continue assisting the user in this forked session.";

export interface HerdrForkInput {
  name?: string;
  folder?: string;
  prompt?: string;
}

export interface HerdrForkResult {
  name: string;
  sessionFile: string;
}

interface SessionFileProvider {
  getSessionFile(): string | undefined;
}

function validateForkName(name: string): string | undefined {
  try {
    validateHerdrAgentName(name);
    return undefined;
  } catch {
    return "herdr-fork name must start with a lowercase letter, contain only lowercase letters, numbers, '_' or '-', and be at most 32 characters";
  }
}

async function resolveForkName(pi: ExtensionAPI, requestedName?: string): Promise<string> {
  const explicitName = requestedName?.trim();
  if (explicitName) return explicitName;

  for (let number = 1; ; number++) {
    const candidate = `fork-${number}`;
    if (!(await agentExists(pi, candidate))) return candidate;
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
  const separator = /(?:^|\s)--(?:\s|$)/.exec(args);
  const optionsText = separator ? args.slice(0, separator.index) : args;
  const prompt = separator ? args.slice(separator.index + separator[0].length) : undefined;
  const tokens = parseCommandLine(optionsText.trim());
  const name = tokens.shift();
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
  const name = input.name?.trim();
  return name ? validateForkName(name) : undefined;
}

export async function forkIntoHerdr(
  pi: ExtensionAPI,
  input: HerdrForkInput,
  cwd: string,
  sessionManager: SessionFileProvider,
  piArgs: string[],
  signal?: AbortSignal,
  branchFromId?: string | null,
): Promise<HerdrForkResult> {
  const validationError = validateInput(input);
  if (validationError) {
    throw new Error(validationError);
  }

  const name = await resolveForkName(pi, input.name);
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
  let started: Awaited<ReturnType<typeof startHerdrPiAgentInSiblingPane>> | undefined;
  try {
    if (branchFromId === null) forked.resetLeaf();
    else if (branchFromId !== undefined) forked.branch(branchFromId);

    const prompt = input.prompt && input.prompt.trim().length > 0 ? input.prompt : undefined;
    forked.appendCustomEntry("pi-herdr:fork", {
      name,
      sourceCwd: cwd,
      targetCwd,
      parentSession,
      sessionFile,
      prompt,
    });
    flushSessionFile(forked, sessionFile);

    started = await startHerdrPiAgentInSiblingPane(pi, {
      name,
      cwd: targetCwd,
      sessionFile,
      piArgs,
      env: { PI_HERDR_FORK: "true" },
    }, signal);
    if (prompt) await promptHerdrAgent(pi, started.agentName, prompt, signal);
    return { name, sessionFile };
  } catch (error) {
    if (started) {
      await closeHerdrAgent(pi, started.agentName, started.paneId).catch(() => undefined);
    }
    fs.rmSync(sessionFile, { force: true });
    throw error;
  }
}

export default function herdrForkExtension(pi: ExtensionAPI): void {
  let forkStarting = false;

  pi.on("before_agent_start", (event) => {
    if (!IS_HERDR_FORK) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${FORK_SYSTEM_PROMPT}` };
  });

  pi.registerCommand("herdr-fork", {
    description: "Fork the current session into a sibling Herdr pane. Usage: /herdr-fork [name] [folder] [-- <prompt>]",
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

      if (forkStarting) {
        ctx.ui.notify("A Herdr fork is already starting.", "warning");
        return;
      }

      forkStarting = true;
      try {
        await ctx.waitForIdle();
        const piArgs = modelCliArgs(ctx.model, pi.getThinkingLevel());
        await forkIntoHerdr(pi, input, ctx.cwd, ctx.sessionManager, piArgs);
      } catch (error) {
        ctx.ui.notify(`herdr-fork failed: ${errorMessage(error)}`, "error");
      } finally {
        forkStarting = false;
      }
    },
  });

  pi.registerShortcut("ctrl+alt+f", {
    description: "Open an idle fork without changing the editor draft",
    handler: async (ctx) => {
      if (forkStarting) {
        ctx.ui.notify("A Herdr fork is already starting.", "warning");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait for the current turn to finish before starting a Herdr fork.", "warning");
        return;
      }

      forkStarting = true;
      try {
        const piArgs = modelCliArgs(ctx.model, pi.getThinkingLevel());
        await forkIntoHerdr(pi, {}, ctx.cwd, ctx.sessionManager, piArgs);
      } catch (error) {
        ctx.ui.notify(`herdr-fork failed: ${errorMessage(error)}`, "error");
      } finally {
        forkStarting = false;
      }
    },
  });
}
