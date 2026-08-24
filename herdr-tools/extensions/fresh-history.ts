import * as path from "node:path";
import { SessionManager, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { closeHerdrAgent, flushSessionFile, modelCliArgs, promptHerdrAgent, startHerdrPiAgent, workerAgentName } from "./herdr-helpers.ts";
import {
  createWorkerArtifacts,
  formatWorkerMoreInfo,
  formatWorkerResult,
  makeWorkerId,
  waitForWorkerResult,
  writeWorkerRequest,
} from "./worker-frame.ts";

const TOOL_NAME = "fresh-history";
const PI_SESSION_ROOT = path.join(process.env.HOME || "/home/claude", ".pi/agent/sessions");

const freshHistoryParams = Type.Object({
  history: Type.Integer({
    minimum: 0,
    description: "Number of recent conversational items to include. Counts user requests and direct assistant replies only; tool calls/results are omitted.",
  }),
  prompt: Type.String({ minLength: 1, description: "Task to run in the fresh history worker." }),
});

type FreshHistoryParams = Static<typeof freshHistoryParams>;

interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

interface FreshHistoryRunResult {
  prompt: string;
  answer: string;
  exitCode: number;
  args: string[];
  requestedHistory: number;
  includedHistory: number;
  parentSession?: string;
  sessionFile?: string;
  moreInfo?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : typeof content === "string" ? [content] : [];
  const texts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      texts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    const type = block.type;
    if ((type === "text" || type === "input_text") && typeof block.text === "string") {
      texts.push(block.text);
    } else if (type === "image" || type === "image_url") {
      texts.push(`[${type}]`);
    }
  }
  return texts.join("\n\n").trim();
}

function hasToolCall(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => isRecord(block) && block.type === "toolCall");
}

function compactAwareEntries(branch: SessionEntry[]): SessionEntry[] {
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]?.type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) return branch;

  const compaction = branch[compactionIndex];
  if (compaction?.type !== "compaction") return branch;

  const entries: SessionEntry[] = [];
  let foundFirstKept = false;
  for (let index = 0; index < compactionIndex; index++) {
    const entry = branch[index];
    if (!entry) continue;
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) entries.push(entry);
  }
  entries.push(...branch.slice(compactionIndex + 1));
  return entries;
}

function collectHistoryItems(entries: SessionEntry[], historyCount: number): HistoryItem[] {
  if (historyCount <= 0) return [];
  const items: HistoryItem[] = [];
  for (const entry of compactAwareEntries(entries)) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = extractTextContent(message.content);
      if (text) items.push({ role: "user", text });
      continue;
    }
    if (message.role === "assistant") {
      if (hasToolCall(message.content)) continue;
      const text = extractTextContent(message.content);
      if (text) items.push({ role: "assistant", text });
    }
  }
  const startIndex = Math.max(0, items.length - historyCount);
  const selected = items.slice(startIndex);
  if (selected[0]?.role === "assistant" && items[startIndex - 1]?.role === "user") {
    return [items[startIndex - 1], ...selected];
  }
  return selected;
}

function renderHistory(items: HistoryItem[]): string {
  if (items.length === 0) return "(no recent user/direct-assistant history requested or available)";
  return items.map((item, index) => {
    const role = item.role === "user" ? "User request" : "Assistant reply";
    return [`## ${index + 1}. ${role}`, "", item.text].join("\n");
  }).join("\n\n");
}

function buildWorkerPrompt(params: FreshHistoryParams, ctx: ExtensionContext, historyItems: HistoryItem[]): string {
  const parentSession = ctx.sessionManager.getSessionFile() ?? "(parent session is not persisted)";
  return [
    "The excerpt below contains only recent user requests and direct assistant replies; tool calls, tool results, and other history are omitted. Use it for orientation and inspect the current environment as needed.",
    `Recovery only: parent session ${parentSession}; session root ${PI_SESSION_ROOT}.`,
    "",
    "# Recent parent conversation",
    "",
    renderHistory(historyItems),
    "",
    "# Task",
    "",
    params.prompt,
  ].join("\n");
}

function formatFreshHistoryResult(result: FreshHistoryRunResult): string {
  const answer = result.answer || "(no output)";
  if (result.exitCode === 0) return answer;
  const recovery = result.moreInfo ? `\n\n${result.moreInfo}` : "";
  return `Fresh-history worker failed (exit code ${result.exitCode}):\n${answer}${recovery}`;
}

function renderFreshHistoryArgs(args: FreshHistoryParams) {
  const payload = JSON.stringify(args, null, 2) ?? String(args);
  const lines = [`${TOOL_NAME}(`, ...payload.split("\n").map((line) => `  ${line}`), ")"];
  return {
    render: (contentWidth: number) => lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth)),
    invalidate: () => {
      /* no-op */
    },
  };
}

async function runFreshHistory(
  pi: ExtensionAPI,
  params: FreshHistoryParams,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
): Promise<FreshHistoryRunResult> {
  const historyItems = collectHistoryItems(ctx.sessionManager.getBranch(), params.history);
  const workerPrompt = buildWorkerPrompt(params, ctx, historyItems);
  const id = makeWorkerId();
  const paths = createWorkerArtifacts();
  const moreInfo = formatWorkerMoreInfo(paths);
  writeWorkerRequest(paths, {
    id,
    task: workerPrompt,
    resultPath: paths.resultPath,
    statusPath: paths.statusPath,
    closeWhenDone: true,
  });

  const args = modelCliArgs(ctx.model, pi.getThinkingLevel());
  const session = SessionManager.create(ctx.cwd);
  const sessionFile = session.getSessionFile();
  const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
  if (!sessionFile) {
    return { prompt: params.prompt, answer: "Could not create a persistent session for fresh-history.", exitCode: 1, args, requestedHistory: params.history, includedHistory: historyItems.length, parentSession, moreInfo };
  }
  session.appendCustomEntry("pi-herdr:fresh-history", { id, requestedHistory: params.history, includedHistory: historyItems.length, parentSession, createdAt: new Date().toISOString() });
  flushSessionFile(session, sessionFile);

  const agentName = workerAgentName("history", id);
  let paneId = "";
  try {
    const started = await startHerdrPiAgent(pi, {
      name: agentName,
      cwd: ctx.cwd,
      sessionFile,
      piArgs: args,
    }, signal);
    paneId = started.paneId;
  } catch (error) {
    return { prompt: params.prompt, answer: error instanceof Error ? error.message : String(error), exitCode: 1, args, requestedHistory: params.history, includedHistory: historyItems.length, parentSession, sessionFile, moreInfo };
  }

  try {
    await promptHerdrAgent(pi, agentName, `/worker-run ${paths.requestPath}`, signal);

    const { result } = await waitForWorkerResult(pi, {
      id,
      agentName,
      paneId,
      paths,
      sessionFile,
      task: params.prompt,
      signal,
      onUpdate,
    });
    return {
      prompt: params.prompt,
      answer: formatWorkerResult(result),
      exitCode: result.isError ? 1 : 0,
      args,
      requestedHistory: params.history,
      includedHistory: historyItems.length,
      parentSession,
      sessionFile,
      moreInfo,
    };
  } catch (error) {
    return { prompt: params.prompt, answer: error instanceof Error ? error.message : String(error), exitCode: 1, args, requestedHistory: params.history, includedHistory: historyItems.length, parentSession, sessionFile, moreInfo };
  } finally {
    if (paneId) await closeHerdrAgent(pi, agentName, paneId).catch(() => undefined);
  }
}

export default function freshHistoryExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Fresh History",
    description: "Run one task in an ephemeral fresh-context worker with a requested number of recent user requests and direct assistant replies; tool activity is omitted. Fresh-history calls run serially. Use when a small excerpt is enough, not for full-context or persistent follow-up work. Returns the answer and automatic retrospective; failures are reported in the returned text.",
    parameters: freshHistoryParams,
    executionMode: "sequential",
    renderCall: renderFreshHistoryArgs,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runFreshHistory(pi, params, ctx, signal, onUpdate);
      return {
        content: [{ type: "text", text: formatFreshHistoryResult(result) }],
        details: {
          result,
          args: result.args,
          parentSession: result.parentSession,
        },
      };
    },
  });
}
