import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { flushSessionFile, runTmux } from "./tmux-helpers.ts";
import { getToolModelCliArgs } from "./tool-model-state.ts";
import {
  createWorkerArtifacts,
  formatWorkerResult,
  makeWorkerId,
  parseActualLockName,
  readWorkerStatus,
  sanitizeWorkerName,
  waitForWorkerReady,
  waitForWorkerResult,
  writeWorkerRequest,
  writeWorkerStatus,
  type WorkerArtifactPaths,
} from "./worker-frame.ts";

const REGISTRY_DIR = "/tmp/pi-ant-coding-agents";
const codingAgentParams = Type.Object({
  name: Type.String({ description: "Name of the persistent fresh-context worker pane." }),
  task: Type.String({ minLength: 1, description: "Task to run in the coding agent." }),
  folder: Type.Optional(Type.String({ description: "Working directory. Defaults to the current working directory." })),
  retrospective: Type.Optional(Type.Boolean({ description: "Ask the worker for a no-tools retrospective after the main result and append it." })),
});

type CodingAgentParams = Static<typeof codingAgentParams>;

interface RegistryEntry {
  name: string;
  lockName: string;
  requestedLockName: string;
  sessionFile: string;
  cwd: string;
  statusPath: string;
  createdAt: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateName(name: string): string {
  const safe = sanitizeWorkerName(name.trim());
  if (!safe || safe !== name.trim() || safe === "." || safe === ".." || safe.includes("..")) {
    throw new Error("coding-agent name must contain only letters, numbers, '.', '_', ':', or '-' and must not contain '..'.");
  }
  return safe;
}

function ensureRegistryDir(): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
}

function registryPath(name: string): string {
  return path.join(REGISTRY_DIR, `${name}.json`);
}

function claimPath(name: string): string {
  return path.join(REGISTRY_DIR, `${name}.claim`);
}

function readRegistry(name: string): RegistryEntry | undefined {
  const file = registryPath(name);
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isRecord(parsed) || typeof parsed.lockName !== "string" || typeof parsed.sessionFile !== "string" || typeof parsed.cwd !== "string" || typeof parsed.statusPath !== "string") {
    return undefined;
  }
  return parsed as unknown as RegistryEntry;
}

function writeRegistry(entry: RegistryEntry): void {
  ensureRegistryDir();
  const file = registryPath(entry.name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...entry, updatedAt: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function claimWorker(name: string): () => void {
  ensureRegistryDir();
  const file = claimPath(name);
  try {
    fs.writeFileSync(file, `${process.pid}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error(`coding-agent '${name}' is already being used by another request.`);
    }
    throw error;
  }
  return () => {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore cleanup failure
    }
  };
}

async function paneExists(pi: ExtensionAPI, lockName: string): Promise<boolean> {
  const result = await runTmux(pi, ["pane-id", lockName]);
  return result.code === 0 && result.stdout.trim().startsWith("%");
}

function isIdle(entry: RegistryEntry): boolean {
  const status = readWorkerStatus(entry.statusPath);
  return status === undefined || status.state === "idle" || status.state === "closed";
}

async function startWorker(pi: ExtensionAPI, _params: CodingAgentParams, name: string, cwd: string, paths: WorkerArtifactPaths, ctx: ExtensionContext): Promise<RegistryEntry> {
  const session = SessionManager.create(cwd);
  const sessionFile = session.getSessionFile();
  if (!sessionFile) throw new Error("Could not create a persistent session for coding-agent.");
  session.appendCustomEntry("pi-ant:coding-agent", { name, cwd, createdAt: new Date().toISOString() });
  flushSessionFile(session, sessionFile);

  const requestedLockName = sanitizeWorkerName(`coding-${name}`);
  const startResult = await runTmux(pi, [
    "session-agent",
    requestedLockName,
    cwd,
    sessionFile,
    "--status-only",
    ...getToolModelCliArgs(ctx),
  ]);
  const startText = [startResult.stdout.trim(), startResult.stderr.trim()].filter(Boolean).join("\n");
  if (startResult.code !== 0) throw new Error(startText || "Failed to start coding-agent.");

  const lockName = parseActualLockName(startText, requestedLockName);
  const entry: RegistryEntry = {
    name,
    lockName,
    requestedLockName,
    sessionFile,
    cwd,
    statusPath: paths.statusPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeRegistry(entry);
  return entry;
}

async function sendWorkerRun(pi: ExtensionAPI, lockName: string, requestPath: string): Promise<void> {
  const result = await runTmux(pi, ["send", lockName, `/worker-run ${requestPath}`]);
  const text = result.stdout.trim() || result.stderr.trim();
  if (result.code !== 0) throw new Error(text || `Failed to send request to coding-agent '${lockName}'.`);
}

function renderCodingAgentArgs(args: CodingAgentParams) {
  const payload = JSON.stringify(args, null, 2) ?? String(args);
  const lines = ["coding-agent(", ...payload.split("\n").map((line) => `  ${line}`), ")"];
  return {
    render: (contentWidth: number) => lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth)),
    invalidate: () => {
      /* no-op */
    },
  };
}

function formatCodingAgentResult(resultText: string, entry: RegistryEntry, paths: WorkerArtifactPaths, contextPercent: number | null | undefined): string {
  const context = contextPercent === null || contextPercent === undefined ? "unknown" : `${contextPercent.toFixed(1)}%`;
  return [
    "## Result",
    resultText,
    "",
    "---",
    `Worker: ${entry.name}`,
    "Status: idle",
    `Context: ${context}`,
    `Session: ${entry.sessionFile}`,
    `Continue manually: pi --session ${entry.sessionFile}`,
    `Artifacts: ${paths.artifactDir}`,
  ].join("\n");
}

export default function codingAgentExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "coding-agent",
    label: "Coding Agent",
    description: "Run a task in a named persistent fresh-context tmux worker and return its result. The worker stays alive for follow-up work.",
    promptSnippet: "Run a task in a persistent fresh-context coding agent.",
    promptGuidelines: [
      "Use coding-agent for fresh-context persistent worker tasks that may need follow-up work.",
      "Use call instead when the worker needs the current conversation context.",
      "The tool waits for the requested task to return; do not pair it with semaphore_wait for normal completion.",
      "Use retrospective for broad/deep work where a second-pass observation is valuable.",
    ],
    parameters: codingAgentParams,
    renderCall: renderCodingAgentArgs,
    async execute(_toolCallId, params, _signal, onUpdate: AgentToolUpdateCallback | undefined, ctx) {
      const name = validateName(params.name);
      const cwd = path.resolve(ctx.cwd, params.folder ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`coding-agent folder does not exist or is not a directory: ${cwd}`);
      }

      const releaseClaim = claimWorker(name);
      try {
        const id = makeWorkerId();
        const paths = createWorkerArtifacts(id);
        writeWorkerRequest(paths, {
          id,
          task: params.task,
          resultPath: paths.resultPath,
          statusPath: paths.statusPath,
          retrospective: params.retrospective === true,
          closeWhenDone: false,
        });

        let entry = readRegistry(name);
        if (entry) {
          if (path.resolve(entry.cwd) !== cwd) {
            throw new Error(`coding-agent '${name}' already exists for ${entry.cwd}; refusing reuse with ${cwd}.`);
          }
          if (!(await paneExists(pi, entry.lockName))) {
            entry = undefined;
          } else if (!isIdle(entry)) {
            throw new Error(`coding-agent '${name}' is busy.`);
          }
        }

        if (!entry) {
          writeWorkerStatus(paths.statusPath, { id, state: "running", resultPath: paths.resultPath, sessionFile: undefined, contextPercent: null });
          entry = await startWorker(pi, params, name, cwd, paths, ctx);
          await waitForWorkerReady(pi, entry.lockName);
          await sendWorkerRun(pi, entry.lockName, paths.requestPath);
        } else {
          writeWorkerStatus(paths.statusPath, { id, state: "running", resultPath: paths.resultPath, sessionFile: entry.sessionFile, contextPercent: null });
          entry = { ...entry, statusPath: paths.statusPath, updatedAt: new Date().toISOString() };
          writeRegistry(entry);
          await sendWorkerRun(pi, entry.lockName, paths.requestPath);
        }

        const { result } = await waitForWorkerResult(pi, {
          id,
          actualLockName: entry.lockName,
          requestedLockName: entry.requestedLockName,
          paths,
          sessionFile: entry.sessionFile,
          task: params.task,
          retrospective: params.retrospective === true,
          onUpdate,
        });
        if (result.isError) throw new Error(result.result);

        const resultText = formatWorkerResult(result);
        const responseText = formatCodingAgentResult(resultText, entry, paths, result.contextPercent);
        return {
          content: [{ type: "text", text: responseText }],
          details: { name, worker: entry, result, artifacts: paths, sessionCommand: `pi --session ${entry.sessionFile}` },
        };
      } finally {
        releaseClaim();
      }
    },
  });
}
