import * as fs from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function fixture(pi: ExtensionAPI): void {
  const provider = fauxProvider({ provider: "take-fixture", models: [{ id: "one", reasoning: true }, { id: "two", reasoning: true }] });
  provider.setResponses([() => { throw new Error("Takeover must not call a model"); }]);
  pi.registerProvider(provider.provider);
  const trace = (event: string, ctx: ExtensionContext) => fs.appendFileSync(process.env.PI_TAKE_TRACE!, `${JSON.stringify({
    event, pid: process.pid, file: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd, pane: process.env.HERDR_PANE_ID,
    control: process.env.PI_ORCHESTRATION_CONTROL, model: ctx.model?.id, thinking: pi.getThinkingLevel(),
    tools: pi.getActiveTools(), branch: ctx.sessionManager.getBranch().map(entry => entry.id),
    draft: ctx.mode === "tui" ? ctx.ui.getEditorText() : "",
  })}\n`);
  pi.on("session_start", (_event, ctx) => trace("start", ctx));
  pi.on("session_shutdown", (event, ctx) => trace(event.reason, ctx));
  pi.on("before_agent_start", (_event, ctx) => trace("unexpected-inference", ctx));
  pi.registerCommand("take-fixture-ugo", { handler: async (args) => { pi.appendEntry("pi-ant:ugo-state", { active: args === "on" }); } });
  pi.registerCommand("take-fixture-state", { handler: async (_args, ctx) => trace("state", ctx) });
  pi.registerCommand("take-fixture-branch", { handler: async (args, ctx) => { await ctx.navigateTree(args, { summarize: false }); trace("branch", ctx); } });
}
