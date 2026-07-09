import * as path from "node:path";
import { SessionManager, type AgentToolUpdateCallback, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { flushSessionFile, runTmux } from "./tmux-helpers.ts";
import { getToolModelCliArgs } from "./tool-model-state.ts";
import {
  createWorkerArtifacts,
  formatWorkerMoreInfo,
  formatWorkerResult,
  makeWorkerId,
  parseActualLockName,
  sanitizeWorkerName,
  waitForWorkerReady,
  waitForWorkerResult,
  writeWorkerRequest,
} from "./worker-frame.ts";

const minitaskParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "One question or small task to answer with a single isolated pi worker.",
  }),
  simple: Type.Optional(
    Type.Boolean({
      description:
        "Use for quick rote tasks, like verifying whether a pattern is used in a file. Without /tool-model, runs pi with --provider openai-codex --model gpt-5.3-codex-spark, retrying with --thinking off if that exits nonzero, then falling back to deepseek/deepseek-v4-pro if Spark still fails. When /tool-model is set, that model is used instead.",
    }),
  ),
});

type MinitaskParams = Static<typeof minitaskParams>;

interface MinitaskRunResult {
  task: string;
  answer: string;
  exitCode: number;
  args: string[];
  sessionFile?: string;
  moreInfo?: string;
}

function isTmuxAvailable(): boolean {
  return !!process.env.TMUX;
}

function buildPiAttempts(simple: boolean, baseArgs: string[]): string[][] {
  if (!simple) return [baseArgs];
  return [
    ["--provider", "openai-codex", "--model", "gpt-5.3-codex-spark", ...baseArgs],
    ["--provider", "openai-codex", "--model", "gpt-5.3-codex-spark", "--thinking", "off", ...baseArgs],
    ["--provider", "deepseek", "--model", "deepseek-v4-pro", ...baseArgs],
  ];
}

function formatMinitaskResult(result: MinitaskRunResult): string {
  const exitLabel = result.exitCode === 0 ? "" : ` (exit code ${result.exitCode})`;
  const sessionLines = result.sessionFile
    ? ["", "## Session", `Reopen manually: pi --session ${result.sessionFile}`]
    : [];
  const moreInfoLines = result.moreInfo ? ["", "---", result.moreInfo] : [];
  return [
    "## Task",
    result.task,
    "",
    `## Answer${exitLabel}`,
    result.answer || "(no output)",
    ...sessionLines,
    ...moreInfoLines,
  ].join("\n");
}

function renderMinitaskArgs(args: MinitaskParams) {
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
}

async function runMinitaskAttempt(
  pi: ExtensionAPI,
  params: MinitaskParams,
  cwd: string,
  args: string[],
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
): Promise<MinitaskRunResult> {
  const id = makeWorkerId();
  const paths = createWorkerArtifacts(id);
  const moreInfo = formatWorkerMoreInfo(paths);
  writeWorkerRequest(paths, {
    id,
    task: params.task,
    resultPath: paths.resultPath,
    statusPath: paths.statusPath,
    closeWhenDone: true,
  });

  const session = SessionManager.create(cwd);
  const sessionFile = session.getSessionFile();
  if (!sessionFile) {
    return { task: params.task, answer: "Could not create a persistent session for minitask.", exitCode: 1, args, moreInfo };
  }
  session.appendCustomEntry("pi-tmux:minitask", { id, createdAt: new Date().toISOString() });
  flushSessionFile(session, sessionFile);

  const requestedLockName = sanitizeWorkerName(`minitask-${path.basename(cwd)}-${id}`);
  const startResult = await runTmux(pi, [
    "session-agent",
    requestedLockName,
    cwd,
    sessionFile,
    "--status-only",
    ...args,
  ], signal);
  const startText = [startResult.stdout.trim(), startResult.stderr.trim()].filter(Boolean).join("\n");
  if (startResult.code !== 0) {
    return { task: params.task, answer: startText || "Failed to start minitask worker.", exitCode: 1, args, sessionFile, moreInfo };
  }

  const actualLockName = parseActualLockName(startText, requestedLockName);
  try {
    await waitForWorkerReady(pi, actualLockName, 10_000, signal);
    const sendResult = await runTmux(pi, ["send", actualLockName, `/worker-run ${paths.requestPath}`], signal);
    if (sendResult.code !== 0) {
      return {
        task: params.task,
        answer: sendResult.stdout.trim() || sendResult.stderr.trim() || "Failed to send minitask request.",
        exitCode: 1,
        args,
        sessionFile,
        moreInfo,
      };
    }

    const { result } = await waitForWorkerResult(pi, {
      id,
      actualLockName,
      requestedLockName,
      paths,
      sessionFile,
      task: params.task,
      signal,
      onUpdate,
    });
    return {
      task: params.task,
      answer: formatWorkerResult(result),
      exitCode: result.isError ? 1 : 0,
      args,
      sessionFile,
      moreInfo,
    };
  } catch (error) {
    return { task: params.task, answer: error instanceof Error ? error.message : String(error), exitCode: 1, args, sessionFile, moreInfo };
  } finally {
    await runTmux(pi, ["kill", actualLockName]).catch(() => undefined);
  }
}

export default function minitaskExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "minitask",
    label: "Minitask",
    description:
      "Run one isolated small task or question about this project/environment with a fresh tmux worker. " +
      "Uses /tool-model when configured and automatically appends a no-tools retrospective. " +
      "For multiple independent tasks, call this tool multiple times in parallel; do not put dependent followups here because each run has no shared context.",
    parameters: minitaskParams,
    renderCall: renderMinitaskArgs,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!isTmuxAvailable()) {
        throw new Error("minitask requires tmux; start pi inside a tmux session to use tmux-backed minitasks.");
      }

      const toolModelArgs = getToolModelCliArgs(ctx);
      let result: MinitaskRunResult | undefined;
      const attempts = buildPiAttempts(params.simple === true && toolModelArgs.length === 0, toolModelArgs);
      for (const args of attempts) {
        result = await runMinitaskAttempt(pi, params, ctx.cwd, args, signal, onUpdate);
        if (result.exitCode === 0) break;
      }

      const finalResult = result ?? { task: params.task, answer: "minitask did not run", exitCode: 1, args: [] };
      return {
        content: [{ type: "text", text: formatMinitaskResult(finalResult) }],
        details: {
          simple: params.simple === true,
          result: finalResult,
          args: finalResult.args,
        },
      };
    },
  });
}
