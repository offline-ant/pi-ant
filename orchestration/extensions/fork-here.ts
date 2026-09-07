import * as fs from "node:fs";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProfileState, parseToolControlState, TOOL_CONTROL_STATE_TYPE } from "../../extensions/tool-control-state.ts";
import { flushSessionFile, modelCliArgs, resolveCwd } from "../context.ts";
import { getHost, hostForTarget } from "../host.ts";
import type { HostTarget } from "../host-types.ts";
import { claimName, readTarget, saveTarget, tryClaimName, validateName } from "../workers.ts";

export interface ForkInput {
  name?: string;
  folder?: string;
  prompt?: string;
}
export interface ForkResult {
  name: string;
  sessionFile: string;
  target: HostTarget;
}

type ForkSession = Pick<ExtensionContext["sessionManager"], "getSessionFile" | "getLeafId" | "getBranch">;

export function parseForkArgs(args: string): ForkInput {
  const separator = /(?:^|\s)--(?:\s|$)/.exec(args);
  const options = separator ? args.slice(0, separator.index) : args;
  const prompt = separator ? args.slice(separator.index + separator[0].length) : undefined;
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let started = false;
  for (const char of options) {
    if (escaping) {
      current += char;
      escaping = false;
    } else if (char === "\\" && quote !== "'") {
      escaping = true;
      started = true;
    } else if ((char === "'" || char === '"') && quote === undefined) {
      quote = char;
      started = true;
    } else if (char === quote) {
      quote = undefined;
    } else if (/\s/.test(char) && quote === undefined) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} quote`);
  if (escaping) current += "\\";
  if (started) tokens.push(current);
  if (tokens.length > 2) throw new Error("Usage: /fork-here [name] [folder] [-- <prompt>]");
  if (tokens.some((token) => token.startsWith("--"))) throw new Error("Unknown fork option");
  const [name, folder] = tokens;
  if (name) validateName(name);
  return { name, folder, prompt };
}

/** Create an independent child; never navigate, submit, or edit the parent. */
export async function forkHere(
  pi: ExtensionAPI,
  input: ForkInput,
  cwd: string,
  sessionManager: ForkSession,
  piArgs: string[],
  signal?: AbortSignal,
  branchFromId: string | null = sessionManager.getLeafId(),
): Promise<ForkResult> {
  signal?.throwIfAborted();
  const host = getHost(pi);
  const parent = host.parent();
  if (!parent) throw new Error("Cannot identify the parent host target for an interactive fork.");
  const targetCwd = resolveCwd(cwd, input.folder);
  const parentSession = sessionManager.getSessionFile();
  if (!parentSession || !fs.existsSync(parentSession)) throw new Error("Current session is not persisted; cannot fork.");

  let name = input.name?.trim();
  let release: () => void;
  if (name) {
    release = claimName(name);
  } else {
    for (let number = 1; ; number++) {
      const candidate = `fork-${number}`;
      const claimed = tryClaimName(candidate);
      if (!claimed) continue;
      if (readTarget(candidate)) {
        claimed();
        continue;
      }
      name = candidate;
      release = claimed;
      break;
    }
  }
  let sessionFile: string | undefined;
  let target: HostTarget | undefined;
  try {
    if (readTarget(name)) throw new Error(`Target '${name}' already exists. Close it explicitly before reusing its name.`);
    const forked = SessionManager.forkFrom(parentSession, targetCwd);
    sessionFile = forked.getSessionFile();
    if (!sessionFile) throw new Error("Could not create a persistent fork session.");
    if (branchFromId === null) forked.resetLeaf();
    else forked.branch(branchFromId);
    forked.appendCustomEntry("pi-orchestration:fork", { name, parentSession, sourceCwd: cwd, targetCwd });
    // Persist the actual tool selection, not merely a profile default. This also
    // lets /tools change it normally in the independent interactive child.
    const previous = sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TOOL_CONTROL_STATE_TYPE).at(-1);
    const state = previous?.type === "custom" ? parseToolControlState(previous.data) : undefined;
    forked.appendCustomEntry(TOOL_CONTROL_STATE_TYPE, {
      ...(state ?? createProfileState("research")),
      enabledTools: pi.getActiveTools(),
      updatedAt: new Date().toISOString(),
    });
    flushSessionFile(forked, sessionFile);
    target = await host.start({
      kind: "pi", name, cwd: targetCwd, sessionFile, args: piArgs,
      placement: "interactive-fork", parent,
      prompt: input.prompt?.trim() ? input.prompt : undefined,
    }, signal);
    signal?.throwIfAborted();
    saveTarget(target);
    return { name, sessionFile, target };
  } catch (error) {
    if (target) await hostForTarget(pi, target).close(target).catch(() => undefined);
    if (sessionFile) fs.rmSync(sessionFile, { force: true });
    throw error;
  } finally {
    release();
  }
}

export default function forkHereExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const purpose = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom"
      && /^pi-orchestration:(?:fork|delegate(?:-runtime)?|coding-agent|fresh-history)$/.test(entry.customType));
    if (purpose?.type !== "custom" || purpose.customType !== "pi-orchestration:fork") return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\nYou are running in an independent interactive fork, not the original controlling session. Continue assisting the user in this forked session.` };
  });
  let starting = false;
  const start = async (input: ForkInput, ctx: ExtensionContext): Promise<void> => {
    if (starting) {
      ctx.ui.notify("A fork is already starting.", "warning");
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      ctx.ui.notify("Wait for the current turn to finish before starting a fork.", "warning");
      return;
    }
    starting = true;
    try {
      const result = await forkHere(pi, input, ctx.cwd, ctx.sessionManager, modelCliArgs(ctx.model, pi.getThinkingLevel()));
      ctx.ui.notify(`Started ${result.name}.`, "info");
    } catch (error) {
      ctx.ui.notify(`fork-here failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      starting = false;
    }
  };
  pi.registerCommand("fork-here", {
    description: "Open an independent session on this host. Usage: /fork-here [name] [folder] [-- <prompt>]",
    handler: async (args, ctx) => {
      try {
        await start(parseForkArgs(args), ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  pi.registerShortcut("ctrl+alt+f", {
    description: "Open an idle fork without changing the editor draft",
    handler: async (ctx) => start({}, ctx),
  });
}
