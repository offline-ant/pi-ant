/**
 * Tmux Extension (script-backed)
 *
 * Delegates tmux operations to ../bin/pi-tmux.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const TMUX_SCRIPT = path.resolve(__dirname, "../bin/pi-tmux");

/** Per-pane state for new-only capture */
const captureState = new Map<string, number>(); // target:paneId -> totalLines at last capture

const DEFAULT_MAX_NEW = 500;

function clearCaptureStateForTarget(target: string): void {
  captureState.delete(target);
  for (const key of [...captureState.keys()]) {
    if (key.startsWith(`${target}:`)) {
      captureState.delete(key);
    }
  }
}

function isTmuxAvailable(): boolean {
  return !!process.env.TMUX;
}

async function runTmux(
  pi: ExtensionAPI,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return pi.exec("bash", [TMUX_SCRIPT, ...args], { signal });
}

function outputText(stdout: string, stderr: string): string {
  const text = stdout.trim() || stderr.trim();
  return text.length > 0 ? text : "(no output)";
}

const tmuxBashParams = Type.Object({
  name: Type.String({
    description: "Lock name for the spawned tmux pane",
  }),
  command: Type.String({
    description: "Command to execute in the tmux pane",
  }),
});
export type TmuxBashInput = Static<typeof tmuxBashParams>;

const tmuxCaptureParams = Type.Object({
  name: Type.String({
    description: "Lock name or pane id (e.g., worker or %12)",
  }),
  lines: Type.Optional(
    Type.Number({ description: "Number of lines to capture (default: 500)" }),
  ),
  watch: Type.Optional(
    Type.String({
      description: "Regex pattern — sets up a semaphore_wait lock that releases when the pattern appears in new pane output.",
    }),
  ),
});
export type TmuxCaptureInput = Static<typeof tmuxCaptureParams>;

const tmuxSendParams = Type.Object({
  name: Type.String({ description: "Lock name or pane id" }),
  text: Type.String({
    description:
      "Text or keys to send (e.g., 'ls -la', 'Enter', 'C-c' for Ctrl+C)",
  }),
  enter: Type.Optional(
    Type.Boolean({
      description: "Whether to press Enter after sending text (default: true)",
    }),
  ),
});
export type TmuxSendInput = Static<typeof tmuxSendParams>;

const tmuxKillParams = Type.Object({
  name: Type.String({ description: "Lock name or pane id" }),
});
export type TmuxKillInput = Static<typeof tmuxKillParams>;

const tmuxCodingAgentParams = Type.Object({
  name: Type.String({
    description: "Lock name for the coding agent",
  }),
  folder: Type.String({
    description: "Working directory for the pi instance (e.g., '../hppr')",
  }),
  piArgs: Type.Optional(
    Type.String({
      description:
        "Additional pi CLI arguments. Omit this to use pi's saved last active model; pass --provider/--model only to override.",
    }),
  ),
  contextAlertPercent: Type.Optional(
    Type.Number({
      description:
        "Context usage percentage (1-100) at which to release a <name>:context lock. " +
        "Use semaphore_wait with the context lock name to be notified when the agent's context is filling up.",
    }),
  ),
});
export type TmuxCodingAgentInput = Static<typeof tmuxCodingAgentParams>;

const minitaskParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "One question or small task to answer with a single isolated pi -p run.",
  }),
  simple: Type.Optional(
    Type.Boolean({
      description:
        "Use for quick rote tasks, like verifying whether a pattern is used in a file. Runs pi with --provider openai-codex --model gpt-5.3-codex-spark, retrying with --thinking off if that exits nonzero, then falling back to deepseek/deepseek-v4-pro if Spark still fails.",
    }),
  ),
});
export type MinitaskInput = Static<typeof minitaskParams>;

type MinitaskResult = {
  task: string;
  answer: string;
  exitCode: number;
};

function formatMinitaskResult(result: MinitaskResult): string {
  const exitLabel = result.exitCode === 0 ? "" : ` (exit code ${result.exitCode})`;
  return [
    "## Task",
    result.task,
    "",
    `## Answer${exitLabel}`,
    result.answer || "(no output)",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!isTmuxAvailable()) {
      ctx.ui.notify(
        "tmux extension: Not running in tmux session (TMUX env not set)",
        "warning",
      );
    }
  });

  pi.registerTool({
    name: "tmux-bash",
    label: "Tmux Bash",
    description:
      "Create a new tmux pane with the given lock name and execute a command. Use ONLY for long-running processes (servers, watch commands, builds >30s).",
    parameters: tmuxBashParams,
    async execute(_toolCallId, params, signal) {
      const args = params.command
        ? ["bash", params.name, params.command]
        : ["bash", params.name];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "tmux-capture",
    label: "Tmux Capture",
    description:
      "Capture output from a tmux pane by lock name or pane id. By default, returns only new lines since the last capture (up to 500). Pass lines: <number> to get the last N lines regardless.",
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

      /** Helper: get current line count from tmux */
      const getLineCount = async () => {
        const r = await runTmux(pi, ["line-count", params.name], signal);
        if (r.code !== 0) return undefined;
        const n = parseInt(r.stdout.trim(), 10);
        return isNaN(n) ? undefined : n;
      };

      /** Helper: do a normal capture of N lines */
      const doCapture = async (n: number) => {
        const args = ["capture", params.name, String(n)];
        const r = await runTmux(pi, args, signal);
        return { args, result: r };
      };

      /** Helper: update stored line count */
      const updateState = async () => {
        const lc = await getLineCount();
        if (lc !== undefined) captureState.set(stateKey, lc);
      };

      if (explicitLines !== undefined) {
        // Explicit lines: old behavior, return last N lines
        const { args, result } = await doCapture(explicitLines);
        resultArgs = args;
        text = outputText(result.stdout, result.stderr);
        resultCode = result.code;

        if (resultCode !== 0) {
          throw new Error(text);
        }

        await updateState();
      } else {
        // New-only mode (default)
        const currentTotal = await getLineCount();

        if (currentTotal === undefined) {
          // Can't get line count — fallback to normal capture
          const { args, result } = await doCapture(maxLines);
          resultArgs = args;
          text = outputText(result.stdout, result.stderr);
          resultCode = result.code;

          if (resultCode !== 0) {
            throw new Error(text);
          }
        } else {
          const prev = captureState.get(stateKey);

          if (prev === undefined || currentTotal < prev) {
            // No prior state or pane was reset — full capture
            const { args, result } = await doCapture(maxLines);
            resultArgs = args;
            text = outputText(result.stdout, result.stderr);
            resultCode = result.code;

            if (resultCode !== 0) {
              throw new Error(text);
            }
          } else {
            const delta = currentTotal - prev;

            if (delta === 0) {
              text = "(no new output)";
              resultCode = 0;
              resultArgs = ["line-count", params.name];

              // Still set up watch if requested, then return
              let watchLock: string | undefined;
              if (params.watch) {
                const watchArgs = ["watch", params.name, params.watch];
                const watchResult = await runTmux(pi, watchArgs, signal);
                const watchText = watchResult.stdout.trim();
                if (watchResult.code !== 0) {
                  text += `\n\n⚠️ Watch setup failed: ${outputText(watchResult.stdout, watchResult.stderr)}`;
                } else {
                  const match = watchText.match(/lock '([^']+)'/);
                  watchLock = match?.[1];
                  text += `\n\n${watchText}`;
                }
              }

              return {
                content: [{ type: "text", text }],
                details: { code: resultCode, args: resultArgs, watchLock },
              };
            }

            // Capture exactly the new lines (capped at maxLines)
            const captureLines = Math.min(delta, maxLines);
            const { args, result } = await doCapture(captureLines);
            resultArgs = args;
            resultCode = result.code;

            if (resultCode !== 0) {
              text = outputText(result.stdout, result.stderr);
              throw new Error(text);
            }

            if (delta > maxLines) {
              text = `⚠️ ${delta} new lines, showing last ${maxLines}. Use lines: ${delta} to see all.\n\n${outputText(result.stdout, result.stderr)}`;
            } else {
              text = outputText(result.stdout, result.stderr);
            }

            if (!text) text = "(no new output)";
            resultCode = 0;
          }
        }

        await updateState();
      }

      // Set up a watch if requested
      let watchLock: string | undefined;
      if (params.watch) {
        const watchArgs = ["watch", params.name, params.watch];
        const watchResult = await runTmux(pi, watchArgs, signal);
        const watchText = watchResult.stdout.trim();

        if (watchResult.code !== 0) {
          text += `\n\n⚠️ Watch setup failed: ${outputText(watchResult.stdout, watchResult.stderr)}`;
        } else {
          // Extract the lock name from the watch output
          const match = watchText.match(/lock '([^']+)'/);
          watchLock = match?.[1];
          text += `\n\n${watchText}`;
        }
      }

      return {
        content: [{ type: "text", text }],
        details: { code: resultCode, args: resultArgs!, watchLock },
      };
    },
  });

  pi.registerTool({
    name: "tmux-send",
    label: "Tmux Send",
    description:
      "Send text or keys to a tmux pane by lock name or pane id. For workflows that wait on completion, pair with semaphore_wait on the same lock name.",
    parameters: tmuxSendParams,
    async execute(_toolCallId, params, signal) {
      const args = [
        "send",
        params.name,
        ...(params.enter === false ? ["--no-enter"] : []),
        params.text,
      ];
      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
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

      if (result.code !== 0) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "tmux-coding-agent",
    label: "Tmux Coding Agent",
    description:
      "Spawn a pi coding agent in a tmux pane using the given lock name and folder. " +
      "Send work via tmux-send('<name>'), wait for completion via semaphore_wait('<name>').",
    parameters: tmuxCodingAgentParams,
    async execute(_toolCallId, params, signal) {
      const args = ["coding-agent", params.name, params.folder];
      if (params.contextAlertPercent !== undefined) {
        args.push("--context-alert", String(params.contextAlertPercent));
      }
      if (params.piArgs) {
        args.push(params.piArgs);
      }

      const result = await runTmux(pi, args, signal);
      const text = outputText(result.stdout, result.stderr);

      if (result.code !== 0) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: { code: result.code, args },
      };
    },
  });

  pi.registerTool({
    name: "minitask",
    label: "Minitask",
    description:
      "Run one isolated small task or question about this project/environment with pi -p. " +
      "For multiple independent tasks, call this tool multiple times in parallel; do not put dependent followups here because each run has no shared context.",
    parameters: minitaskParams,
    renderCall(args) {
      const payloadValue = args.task === undefined
        ? args
        : args.simple === true
          ? { task: args.task, simple: true }
          : args.task;
      const payload = JSON.stringify(payloadValue, null, 2) ?? String(payloadValue);
      const lines = ["minitask(", ...payload.split("\n").map((line) => `  ${line}`), ")"];

      return {
        render: (contentWidth: number) => lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth)),
        invalidate: () => {
          /* no-op */
        },
      };
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let answer = "(no output)";
      let exitCode = 0;

      try {
        const runPi = (args: string[]) => pi.exec("pi", args, {
          signal,
          cwd: ctx.cwd,
        });
        const args = params.simple === true
          ? ["--provider", "openai-codex", "--model", "gpt-5.3-codex-spark", "-p", params.task]
          : ["-p", params.task];
        let result = await runPi(args);

        if (params.simple === true && result.code !== 0) {
          result = await runPi([
            "--provider",
            "openai-codex",
            "--model",
            "gpt-5.3-codex-spark",
            "--thinking",
            "off",
            "-p",
            params.task,
          ]);
        }

        if (params.simple === true && result.code !== 0) {
          result = await runPi([
            "--provider",
            "deepseek",
            "--model",
            "deepseek-v4-pro",
            "-p",
            params.task,
          ]);
        }

        exitCode = result.code;
        answer = outputText(result.stdout, result.stderr);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw err;
        }

        answer = `Error: ${err instanceof Error ? err.message : String(err)}`;
        exitCode = 1;
      }

      const result = {
        task: params.task,
        answer,
        exitCode,
      };
      const text = formatMinitaskResult(result);

      return {
        content: [{ type: "text", text }],
        details: {
          simple: params.simple === true,
          result,
        },
      };
    },
  });

  pi.registerCommand("clear-stale", {
    description: "Clean up semaphore lock files and state for dead tmux panes",
    handler: async (_args, ctx) => {
      const result = await runTmux(pi, ["clear-stale"]);
      const text = outputText(result.stdout, result.stderr);
      ctx.ui.notify(text, result.code === 0 ? "info" : "error");
    },
  });

  pi.registerCommand("tmux-list", {
    description: "List active tmux panes",
    handler: async (_args, ctx) => {
      const result = await runTmux(pi, ["list"]);
      const text = outputText(result.stdout, result.stderr);
      ctx.ui.notify(text, result.code === 0 ? "info" : "error");
    },
  });
}
