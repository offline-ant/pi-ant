import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, type ExtensionContext, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { cleanContextCliArgs, EPHEMERAL_WORKER_CONTEXTS, type EphemeralWorkerTool } from "./delegate-policy.ts";

export function modelCliArgs(model: { provider: string; id: string } | undefined, thinkingLevel: string): string[] {
  if (!model) throw new Error("Current session has no selected model; cannot start a child Pi process.");
  // Pi treats this prefix as provider syntax even with --provider. A bare id
  // such as example/review could otherwise silently start example's review model.
  if (model.id.toLowerCase().startsWith(`${model.provider.toLowerCase()}/`)) {
    throw new Error(`Cannot start child model ${model.provider}/${model.id}: Pi's CLI interprets the model id's provider prefix ambiguously.`);
  }
  return ["--provider", model.provider, "--model", model.id, "--thinking", thinkingLevel];
}

export function flushSessionFile(sessionManager: SessionManager, sessionFile: string): void {
  const header = sessionManager.getHeader();
  if (!header) throw new Error("New session has no header");
  const entries: Array<SessionHeader | SessionEntry> = [header, ...sessionManager.getEntries()];
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
}

export function getPreToolCallLeafId(
  sessionManager: Pick<SessionManager, "getBranch">,
  toolName: string,
  toolCallId: string,
): string | null {
  const branch = sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if (entry.message.content.some((item) => item.type === "toolCall" && item.id === toolCallId && item.name === toolName)) {
      return entry.parentId ?? null;
    }
  }
  throw new Error(`Could not identify ${toolName} tool call ${toolCallId} in the current session branch; refusing to fork an unmatched transcript.`);
}

export function resolveCwd(base: string, folder?: string): string {
  const cwd = path.resolve(base, folder ?? ".");
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`folder does not exist or is not a directory: ${cwd}`);
  }
  return cwd;
}

export function prepareFreshSession(cwd: string, purpose: string, data: unknown): string {
  const session = SessionManager.create(cwd);
  const sessionFile = session.getSessionFile();
  if (!sessionFile) throw new Error(`Could not create a persistent session for ${purpose}.`);
  session.appendCustomEntry(`pi-orchestration:${purpose}`, data);
  flushSessionFile(session, sessionFile);
  return sessionFile;
}

export function prepareDelegateSession(
  request: { tool: EphemeralWorkerTool; folder?: string; task: string },
  ctx: ExtensionContext,
  toolCallId: string,
  runtime: { model: { provider: string; id: string }; thinkingLevel: string },
): { cwd: string; sessionFile: string; args: string[] } {
  if (request.tool === "do" && request.folder !== undefined) {
    throw new Error("do does not accept folder; use delegate for a standalone assignment in another directory.");
  }
  const cwd = resolveCwd(ctx.cwd, request.folder);
  const args = modelCliArgs(runtime.model, runtime.thinkingLevel);
  const context = EPHEMERAL_WORKER_CONTEXTS[request.tool];
  if (context !== "inherit") {
    const sessionFile = prepareFreshSession(cwd, "delegate", { tool: request.tool, context, createdAt: new Date().toISOString() });
    return { cwd, sessionFile, args: [...args, ...cleanContextCliArgs(context, fileURLToPath(new URL("./worker-frame.ts", import.meta.url)))] };
  }
  const parentSession = ctx.sessionManager.getSessionFile();
  if (!parentSession || !fs.existsSync(parentSession)) throw new Error("Current session is not persisted; cannot start do.");
  const leafId = getPreToolCallLeafId(ctx.sessionManager, request.tool, toolCallId);
  const forked = SessionManager.forkFrom(parentSession, cwd);
  const sessionFile = forked.getSessionFile();
  if (!sessionFile) throw new Error("Could not create a persistent session for do.");
  if (leafId === null) forked.resetLeaf();
  else forked.branch(leafId);
  forked.appendCustomEntry("pi-orchestration:delegate-runtime", { task: request.task, parentSession, childSession: sessionFile, cwd });
  flushSessionFile(forked, sessionFile);
  return { cwd, sessionFile, args };
}

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

export function collectHistoryItems(entries: SessionEntry[], count: number): HistoryItem[] {
  if (count <= 0) return [];
  const items: HistoryItem[] = [];
  const messages = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "assistant" && message.content.some((block) => block.type === "toolCall")) continue;
    const text = typeof message.content === "string" ? message.content : message.content
      .flatMap((block) => block.type === "text" ? [block.text] : block.type === "image" ? ["[image]"] : []).join("\n\n").trim();
    if (text) items.push({ role: message.role, text });
  }
  const start = Math.max(0, items.length - count);
  return items.slice(items[start]?.role === "assistant" && items[start - 1]?.role === "user" ? start - 1 : start);
}
