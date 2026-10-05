import { keyHint, type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { workerResumeHint } from "./worker-resume.ts";

/** Recovery metadata is rendered for the user, never added to successful content. */
export function renderWorkerResult(result: AgentToolResult<unknown>, { expanded }: ToolRenderResultOptions, theme: Theme): Text {
  const details = result.details;
  const command = typeof details === "object" && details !== null && "sessionCommand" in details
    && typeof details.sessionCommand === "string" ? details.sessionCommand : undefined;
  const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const lines = output.split("\n");
  const displayed = expanded ? lines : lines.slice(0, 10);
  const parts: string[] = [];
  if (command) {
    parts.push(theme.fg("muted", `User-only recovery command (not sent to model):\n${workerResumeHint(command)}`));
  }
  parts.push(displayed.map((line) => theme.fg("toolOutput", line)).join("\n"));
  if (lines.length > displayed.length) {
    parts.push(theme.fg("muted", `... (${lines.length - displayed.length} more lines, `)
      + keyHint("app.tools.expand", "to expand") + theme.fg("muted", ")"));
  }
  return new Text(parts.join("\n\n"), 0, 0);
}
