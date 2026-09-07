import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, type Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Deterministic native-host fixture: every model call stays inside Pi's faux provider. */
export default function lifecycleFixture(pi: ExtensionAPI): void {
  const directory = process.cwd();
  let sessionFile: string | undefined;
  const trace = (event: object): void => fs.appendFileSync(path.join(directory, "lifecycle-trace.jsonl"), `${JSON.stringify({ pid: process.pid, session: sessionFile, ...event })}\n`);
  const report = (event: string, ctx: ExtensionContext): void => trace({ event, draft: ctx.ui.getEditorText(), idle: ctx.isIdle(),
    tools: pi.getActiveTools(), provider: ctx.model?.provider, model: ctx.model?.id, thinking: pi.getThinkingLevel(),
    leaf: ctx.sessionManager.getLeafId(), commands: pi.getCommands().map((command) => command.name) });
  const provider = fauxProvider({
    provider: "orchestration-fixture",
    models: [{ id: "one", reasoning: true }, { id: "two", reasoning: true }],
    tokensPerSecond: 100_000,
  });
  const retryPrompts = new Set<string>();
  const overflowPrompts = new Set<string>();
  const text = (context: Context): string => {
    const messages = context.messages.flatMap((message) => message.role !== "user" ? [] : [
      typeof message.content === "string" ? message.content
        : message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n"),
    ]);
    return messages.findLast((message) => !message.startsWith("A human is supervising this worker.")) ?? "";
  };
  provider.setResponses(Array.from({ length: 100 }, () => async (context, options, _state, model) => {
    const prompt = text(context);
    const retrospective = prompt.startsWith("The main result has already been saved");
    const summary = prompt.startsWith("<conversation>\n");
    trace({ event: "request", prompt, retrospective, summary, model: model.id, reasoning: options?.reasoning,
      tools: context.tools?.map((tool) => tool.name) ?? [] });
    if (summary) {
      while (!fs.existsSync(path.join(directory, "release-compaction"))) await delay(25, undefined, { signal: options?.signal });
      return fauxAssistantMessage("## Goal\nContinue the active fixture task after overflow recovery.");
    }
    if (prompt.includes("[overflow-once]") && !overflowPrompts.has(prompt)) {
      overflowPrompts.add(prompt);
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 200001 tokens > 200000 maximum" });
    }
    if (prompt.includes("[hold]")) {
      while (!fs.existsSync(path.join(directory, "release"))) await delay(25, undefined, { signal: options?.signal });
    }
    if (prompt.includes("[retry-once]") && !retryPrompts.has(prompt)) {
      retryPrompts.add(prompt);
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable: fixture retry" });
    }
    if (retrospective && fs.existsSync(path.join(directory, "fail-retrospective"))) {
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture permanent retrospective failure" });
    }
    return fauxAssistantMessage(retrospective ? "fixture retrospective" : `fixture result: ${prompt.split("\n").at(-1)}`);
  }));
  pi.registerProvider(provider.provider);
  pi.on("session_start", (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile();
    report("startup", ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.model?.provider !== "orchestration-fixture") throw new Error("Native lifecycle fixture refuses non-faux providers");
  });
  pi.on("input", (event) => { trace({ event: "input", text: event.text, source: event.source, behavior: event.streamingBehavior }); });
  pi.on("agent_end", (event) => { trace({ event: "agent-end", stopReason: event.messages.findLast((message) => message.role === "assistant")?.stopReason }); });
  pi.on("session_before_compact", (event) => { trace({ event: "before-compact", reason: event.reason, willRetry: event.willRetry }); });
  pi.on("session_compact", (event) => { trace({ event: "compacted", reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension }); });
  pi.on("session_compact_failed", (event) => { trace({ event: "compaction-failed", reason: event.reason, error: event.errorMessage }); });
  pi.on("agent_settled", () => { trace({ event: "settled" }); });
  pi.registerCommand("lifecycle-report", { handler: async (_args, ctx) => { report("report", ctx); } });
  pi.registerCommand("lifecycle-clear-draft", { handler: async (_args, ctx) => { ctx.ui.setEditorText(""); } });
}
