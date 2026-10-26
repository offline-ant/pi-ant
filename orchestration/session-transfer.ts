import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TOOL_SELECTION_ENTRY } from "../extensions/tool-selection.ts";
import { modelCliArgs } from "./context.ts";
import type { HostTarget } from "./host-types.ts";
import { switchEnvironment, type SwitchSource } from "./switch-destinations.ts";

const TRANSFERRING = Symbol.for("pi-orchestration:transferring");
export function transferOperation(): { active: boolean } {
  const global = globalThis as typeof globalThis & { [TRANSFERRING]?: { active: boolean } };
  return global[TRANSFERRING] ??= { active: false };
}

export interface SessionTransfer {
  sessionFile: string;
  cwd: string;
  agentDir: string;
  leafId: string | null;
  model: { provider: string; id: string };
  thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  tools: string[];
}

export function agentDirectory(environment: NodeJS.ProcessEnv): string {
  return path.resolve(environment.PI_CODING_AGENT_DIR || path.join(environment.HOME || os.homedir(), ".pi", "agent"));
}

/** Used on both ends, including after asynchronous selection and preflight. */
export function assertTransferIdle(pi: ExtensionAPI, ctx: ExtensionContext, targets: HostTarget[]): void {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current turn and queued messages to finish before transferring.");
  const guard = { blocked: false };
  pi.events.emit("pi-orchestration:switch-check", guard);
  if (guard.blocked) throw new Error("Cannot transfer an active managed worker.");
  const ugo = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "pi-ant:ugo-state");
  if (ugo?.type === "custom" && typeof ugo.data === "object" && ugo.data !== null && "active" in ugo.data && ugo.data.active === true) {
    throw new Error("Stop Ugo before transferring this session.");
  }
  const file = ctx.sessionManager.getSessionFile();
  const canonical = (value: string) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  if (file && targets.some(target => target.sessionFile && canonical(target.sessionFile) === canonical(file))) {
    throw new Error("Cannot transfer a registered worker or interactive fork. Finish its managed lifecycle first.");
  }
}

export function captureTransfer(pi: ExtensionAPI, ctx: ExtensionContext, environment: NodeJS.ProcessEnv): SessionTransfer {
  const file = ctx.sessionManager.getSessionFile();
  if (!file || !fs.existsSync(file)) throw new Error("This session is not persisted; send a message before transferring.");
  if (!ctx.model) throw new Error("Select a model before transferring.");
  const tools = pi.getActiveTools();
  return {
    sessionFile: fs.realpathSync(file), cwd: ctx.cwd, agentDir: agentDirectory(environment),
    leafId: ctx.sessionManager.getLeafId(), model: { provider: ctx.model.provider, id: ctx.model.id },
    thinking: pi.getThinkingLevel(), tools,
  };
}

export function saveTransfer(pi: ExtensionAPI, ctx: ExtensionContext, environment: NodeJS.ProcessEnv): SessionTransfer {
  const transfer = captureTransfer(pi, ctx, environment);
  pi.appendEntry(TOOL_SELECTION_ENTRY, { enabledTools: transfer.tools });
  transfer.leafId = ctx.sessionManager.getLeafId();
  return transfer;
}

export function switchSource(transfer: SessionTransfer, environment: NodeJS.ProcessEnv): SwitchSource {
  const env = switchEnvironment(environment);
  if (environment.PI_ORCHESTRATION_HOST === "herdr" && environment.PI_ORCHESTRATION_ENDPOINT) env.HERDR_SOCKET_PATH = environment.PI_ORCHESTRATION_ENDPOINT;
  return { sessionFile: transfer.sessionFile, cwd: transfer.cwd, args: modelCliArgs(transfer.model, transfer.thinking), env };
}

export function verifyTransfer(ctx: ExtensionContext, transfer: SessionTransfer): void {
  const file = ctx.sessionManager.getSessionFile();
  if (!file || fs.realpathSync(file) !== transfer.sessionFile || ctx.cwd !== transfer.cwd
    || (transfer.leafId !== null && !ctx.sessionManager.getBranch().some(entry => entry.id === transfer.leafId))) {
    throw new Error("The destination did not load the expected session, working directory and branch.");
  }
  if (ctx.model?.provider !== transfer.model.provider || ctx.model?.id !== transfer.model.id) throw new Error("The destination did not preserve the selected model.");
}
