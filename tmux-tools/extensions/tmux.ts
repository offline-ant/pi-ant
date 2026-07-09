import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { runTmux } from "./tmux-helpers.ts";

const captureState = new Map<string, number>();
const DEFAULT_MAX_NEW = 500;

function clearCaptureStateForTarget(target: string): void {
  captureState.delete(target);
  for (const key of [...captureState.keys()]) {
    if (key.startsWith(`${target}:`)) captureState.delete(key);
  }
}

function isTmuxAvailable(): boolean {
  return !!process.env.TMUX;
}

function outputText(stdout: string, stderr: string): string {
  const text = stdout.trim() || stderr.trim();
  return text.length > 0 ? text : "(no output)";
}

const tmuxBashParams = Type.Object({
  name: Type.String({ description: "Lock name for the spawned tmux pane" }),
  command: Type.String({ description: "Command to execute in the tmux pane" }),
});
export type TmuxBashInput = Static<typeof tmuxBashParams>;

const tmuxCaptureParams = Type.Object({
  name: Type.String({ description: "Lock name or pane id (e.g., worker or %12)" }),
  lines: Type.Optional(Type.Number({ description: "Number of lines to capture (default: 500)" })),
  watch: Type.Optional(
    Type.String({ description: "Regex pattern — sets up a semaphore_wait lock that releases when the pattern appears in new pane output." }),
  ),
});
export type TmuxCaptureInput = Static<typeof tmuxCaptureParams>;

const tmuxSendParams = Type.Object({
  name: Type.String({ description: "Lock name or pane id" }),
  text: Type.String({ description: "Text or keys to send (e.g., 'ls -la', 'Enter', 'C-c' for Ctrl+C)" }),
  enter: Type.Optional(Type.Boolean({ description: "Whether to press Enter after sending text (default: true)" })),
});
export type TmuxSendInput = Static<typeof tmuxSendParams>;

const tmuxKillParams = Type.Object({
  name: Type.String({ description: "Lock name or pane id" }),
});
export type TmuxKillInput = Static<typeof tmuxKillParams>;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!isTmuxAvailable()) {
      ctx.ui.notify("tmux extension: Not running in tmux session (TMUX env not set)", "warning");
    }
  });

  pi.registerTool({
    name: "tmux-bash",
    label: "Tmux Bash",
    description: "Create a new tmux pane with the given lock name and execute a command. Use ONLY for long-running processes (servers, watch commands, builds >30s).",
    parameters: tmuxBashParams,
    async execute(_toolCallId, params, signal) {
      const args = params.command ? ["bash", params.name, params.command] : ["bash", params.name];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);
      if (result.code !== 0) throw new Error(text);
      return { content: [{ type: "text", text }], details: { code: result.code, args } };
    },
  });

  pi.registerTool({
    name: "tmux-capture",
    label: "Tmux Capture",
    description: "Capture output from a tmux pane by lock name or pane id. By default, returns only new lines since the last capture (up to 500). Pass lines: <number> to get the last N lines regardless.",
    parameters: tmuxCaptureParams,
    async execute(_toolCallId, params, signal) {
      const explicitLines = params.lines;
      const maxLines = explicitLines ?? DEFAULT_MAX_NEW;
      const paneIdResult = await runTmux(pi, ["pane-id", params.name], signal);
      const paneId = paneIdResult.code === 0 ? paneIdResult.stdout.trim() : undefined;
      const stateKey = paneId ? `${params.name}:${paneId}` : params.name;

      let text: string;
      let resultCode: number;
      let resultArgs: string[];

      const getLineCount = async () => {
        const result = await runTmux(pi, ["line-count", params.name], signal);
        if (result.code !== 0) return undefined;
        const count = parseInt(result.stdout.trim(), 10);
        return Number.isNaN(count) ? undefined : count;
      };

      const doCapture = async (lines: number) => {
        const args = ["capture", params.name, String(lines)];
        const result = await runTmux(pi, args, signal);
        return { args, result };
      };

      const updateState = async () => {
        const lineCount = await getLineCount();
        if (lineCount !== undefined) captureState.set(stateKey, lineCount);
      };

      if (explicitLines !== undefined) {
        const captured = await doCapture(explicitLines);
        resultArgs = captured.args;
        text = outputText(captured.result.stdout, captured.result.stderr);
        resultCode = captured.result.code;
        if (resultCode !== 0) throw new Error(text);
        await updateState();
      } else {
        const currentTotal = await getLineCount();
        if (currentTotal === undefined) {
          const captured = await doCapture(maxLines);
          resultArgs = captured.args;
          text = outputText(captured.result.stdout, captured.result.stderr);
          resultCode = captured.result.code;
          if (resultCode !== 0) throw new Error(text);
        } else {
          const previous = captureState.get(stateKey);
          if (previous === undefined || currentTotal < previous) {
            const captured = await doCapture(maxLines);
            resultArgs = captured.args;
            text = outputText(captured.result.stdout, captured.result.stderr);
            resultCode = captured.result.code;
            if (resultCode !== 0) throw new Error(text);
          } else {
            const delta = currentTotal - previous;
            if (delta === 0) {
              text = "(no new output)";
              resultCode = 0;
              resultArgs = ["line-count", params.name];
            } else {
              const captureLines = Math.min(delta, maxLines);
              const captured = await doCapture(captureLines);
              resultArgs = captured.args;
              resultCode = captured.result.code;
              if (resultCode !== 0) throw new Error(outputText(captured.result.stdout, captured.result.stderr));
              text = delta > maxLines
                ? `⚠️ ${delta} new lines, showing last ${maxLines}. Use lines: ${delta} to see all.\n\n${outputText(captured.result.stdout, captured.result.stderr)}`
                : outputText(captured.result.stdout, captured.result.stderr);
            }
          }
        }
        await updateState();
      }

      let watchLock: string | undefined;
      if (params.watch) {
        const watchArgs = ["watch", params.name, params.watch];
        const watchResult = await runTmux(pi, watchArgs, signal);
        const watchText = watchResult.stdout.trim();
        if (watchResult.code !== 0) {
          text += `\n\n⚠️ Watch setup failed: ${outputText(watchResult.stdout, watchResult.stderr)}`;
        } else {
          watchLock = watchText.match(/lock '([^']+)'/)?.[1];
          text += `\n\n${watchText}`;
        }
      }

      return { content: [{ type: "text", text }], details: { code: resultCode, args: resultArgs, watchLock } };
    },
  });

  pi.registerTool({
    name: "tmux-send",
    label: "Tmux Send",
    description: "Send text or keys to a tmux pane by lock name or pane id. For workflows that wait on completion, pair with semaphore_wait on the same lock name.",
    parameters: tmuxSendParams,
    async execute(_toolCallId, params, signal) {
      const args = ["send", params.name, ...(params.enter === false ? ["--no-enter"] : []), params.text];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);
      if (result.code !== 0) throw new Error(text);
      return { content: [{ type: "text", text }], details: { code: result.code, args } };
    },
  });

  pi.registerTool({
    name: "tmux-kill",
    label: "Tmux Kill",
    description: "Kill a tmux pane by lock name or pane id.",
    parameters: tmuxKillParams,
    async execute(_toolCallId, params, signal) {
      clearCaptureStateForTarget(params.name);
      const args = ["kill", params.name];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);
      if (result.code !== 0) throw new Error(text);
      return { content: [{ type: "text", text }], details: { code: result.code, args } };
    },
  });

  pi.registerCommand("clear-stale", {
    description: "Clean up semaphore lock files and state for dead tmux panes",
    handler: async (_args, ctx) => {
      const result = await runTmux(pi, ["clear-stale"]);
      ctx.ui.notify(outputText(result.stdout, result.stderr), result.code === 0 ? "info" : "error");
    },
  });

  pi.registerCommand("tmux-list", {
    description: "List active tmux panes",
    handler: async (_args, ctx) => {
      const result = await runTmux(pi, ["list"]);
      ctx.ui.notify(outputText(result.stdout, result.stderr), result.code === 0 ? "info" : "error");
    },
  });

}
