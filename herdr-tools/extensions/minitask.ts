import * as path from "node:path";
import { SessionManager, type AgentToolUpdateCallback, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { closePane, flushSessionFile, resolveCwd, sendTextToPane, startHerdrPiPane } from "./herdr-helpers.ts";
import { getToolModelCliArgs } from "./tool-model-state.ts";
import {
  createWorkerArtifacts,
  formatWorkerMoreInfo,
  formatWorkerResult,
  makeWorkerId,
  sanitizeWorkerName,
  waitForWorkerReady,
  waitForWorkerResult,
  writeWorkerRequest,
} from "./worker-frame.ts";
import { WORKER_DESIGN_PRINCIPLES } from "./worker-principles.ts";

const minitaskParams = Type.Object({
  task: Type.String({
    minLength: 1,
    description: "One question or small task to answer with a single isolated pi worker.",
  }),
  folder: Type.Optional(Type.String({ description: "Working directory. Defaults to the current working directory." })),
  simple: Type.Optional(
    Type.Boolean({
      description:
        "Use for quick rote tasks. Without /tool-model, tries GPT-5.6 Sol with thinking off, then low. With /tool-model, uses that override.",
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

function buildPiAttempts(simple: boolean, baseArgs: string[]): string[][] {
  if (!simple) return [baseArgs];
  return [
    ["--provider", "openai-codex", "--model", "gpt-5.6-sol", "--thinking", "off", ...baseArgs],
    ["--provider", "openai-codex", "--model", "gpt-5.6-sol", "--thinking", "low", ...baseArgs],
  ];
}

function formatMinitaskResult(result: MinitaskRunResult): string {
  const answer = result.answer || "(no output)";
  if (result.exitCode === 0) return answer;
  const recovery = result.moreInfo ? `\n\n${result.moreInfo}` : "";
  return `Minitask failed (exit code ${result.exitCode}):\n${answer}${recovery}`;
}

function renderMinitaskArgs(args: MinitaskParams) {
  const payloadValue = args.task === undefined
    ? args
    : args.folder !== undefined || args.simple === true
      ? args
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
  const paths = createWorkerArtifacts();
  const moreInfo = formatWorkerMoreInfo(paths);
  writeWorkerRequest(paths, {
    id,
    task: [WORKER_DESIGN_PRINCIPLES, "", "Task:", params.task].join("\n"),
    resultPath: paths.resultPath,
    statusPath: paths.statusPath,
    closeWhenDone: true,
  });

  const session = SessionManager.create(cwd);
  const sessionFile = session.getSessionFile();
  if (!sessionFile) {
    return { task: params.task, answer: "Could not create a persistent session for minitask.", exitCode: 1, args, moreInfo };
  }
  session.appendCustomEntry("pi-herdr:minitask", { id, createdAt: new Date().toISOString() });
  flushSessionFile(session, sessionFile);

  const requestedLockName = sanitizeWorkerName(`minitask-${path.basename(cwd)}-${id}`);
  let actualLockName = "";
  try {
    const started = await startHerdrPiPane(pi, {
      name: requestedLockName,
      cwd,
      sessionFile,
      piArgs: args,
      placement: "tab",
    }, signal);
    actualLockName = started.paneId;
  } catch (error) {
    return { task: params.task, answer: error instanceof Error ? error.message : String(error), exitCode: 1, args, sessionFile, moreInfo };
  }
  try {
    await waitForWorkerReady(pi, actualLockName, 10_000, signal);
    await sendTextToPane(pi, actualLockName, `/worker-run ${paths.requestPath}`, true, signal);

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
    if (actualLockName) await closePane(pi, actualLockName).catch(() => undefined);
  }
}

export default function minitaskExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "minitask",
    label: "Minitask",
    description: "Run one isolated task in an ephemeral fresh-context worker and wait for completion. Independent calls may run in parallel; dependent follow-ups need another worker type. Returns the answer and automatic retrospective; failures are reported in the returned text.",
    parameters: minitaskParams,
    renderCall: renderMinitaskArgs,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = resolveCwd(ctx.cwd, params.folder);
      const toolModelArgs = getToolModelCliArgs(ctx);
      let result: MinitaskRunResult | undefined;
      const attempts = buildPiAttempts(params.simple === true && toolModelArgs.length === 0, toolModelArgs);
      for (const args of attempts) {
        result = await runMinitaskAttempt(pi, params, cwd, args, signal, onUpdate);
        if (result.exitCode === 0) break;
      }

      const finalResult = result ?? { task: params.task, answer: "minitask did not run", exitCode: 1, args: [] };
      return {
        content: [{ type: "text", text: formatMinitaskResult(finalResult) }],
        details: {
          cwd,
          simple: params.simple === true,
          result: finalResult,
          args: finalResult.args,
        },
      };
    },
  });
}
