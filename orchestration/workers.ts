import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { truncateTail, type AgentToolUpdateCallback, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHost, hostForTarget } from "./host.ts";
import type { HostTarget } from "./host-types.ts";
import { appendWorkerMoreInfo, parseWorkerResult, readWorkerStatus, type WorkerArtifactPaths, type WorkerResultFile } from "./worker-frame.ts";

const REGISTRY_DIR = path.join(os.tmpdir(), "pi-orchestration-targets");
const RESULT_POLL_INTERVAL_MS = 250;
const PROGRESS_UPDATE_INTERVAL_MS = 5000;
const STATE_POLL_INTERVAL_MS = 1000;
const STATE_UNAVAILABLE_GRACE_MS = 5000;

export interface PersistentWorker {
  target: HostTarget;
  cwd: string;
  sessionFile: string;
  statusPath: string;
}
interface RegistryEntry {
  target: HostTarget;
  worker?: PersistentWorker;
}

export function validateName(name: string): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Error("Name must start with a lowercase letter, contain only lowercase letters, numbers, '_' or '-', and be at most 32 characters.");
  }
  return name;
}

function registryPath(name: string): string {
  return path.join(REGISTRY_DIR, `${validateName(name)}.json`);
}

function readEntry(name: string): RegistryEntry | undefined {
  const file = registryPath(name);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as RegistryEntry;
}

function saveEntry(entry: RegistryEntry): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  const file = registryPath(entry.target.name);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function tryClaimName(name: string): (() => void) | undefined {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  const file = `${registryPath(name)}.claim`;
  try {
    fs.writeFileSync(file, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    fs.unlinkSync(file);
    released = true;
  };
}

export function claimName(name: string): () => void {
  const release = tryClaimName(name);
  if (!release) throw new Error(`'${name}' is already being used by another request (claim: ${registryPath(name)}.claim).`);
  return release;
}

export function readTarget(name: string): HostTarget | undefined {
  return readEntry(name)?.target;
}

export function saveTarget(target: HostTarget): void {
  saveEntry({ target });
}

export function removeTarget(name: string): void {
  fs.rmSync(registryPath(name), { force: true });
}

export function listTargets(): HostTarget[] {
  if (!fs.existsSync(REGISTRY_DIR)) return [];
  return fs.readdirSync(REGISTRY_DIR).filter((file) => file.endsWith(".json"))
    .map((file) => readTarget(file.slice(0, -5))).filter((target): target is HostTarget => target !== undefined);
}

export function readPersistentWorker(name: string): PersistentWorker | undefined {
  const entry = readEntry(name);
  if (entry && !entry.worker) throw new Error(`'${name}' belongs to another panel or interactive fork, not a persistent worker.`);
  return entry?.worker;
}

export function savePersistentWorker(worker: PersistentWorker): void {
  saveEntry({ target: worker.target, worker });
}

export interface WorkerToolDetails {
  id: string;
  target: HostTarget;
  artifacts: WorkerArtifactPaths;
  sessionFile: string;
  task: string;
  elapsedMs: number;
  status: string;
}

export async function captureWorkerOutput(pi: ExtensionAPI, target: HostTarget, lines = 12, signal?: AbortSignal): Promise<string> {
  try {
    return truncateTail(await hostForTarget(pi, target).read(target, lines, signal), { maxLines: lines, maxBytes: 8192 }).content || "(no output)";
  } catch (error) {
    signal?.throwIfAborted();
    return `Could not capture ${target.host} output for ${target.name}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function waitForWorkerResult(
  pi: ExtensionAPI,
  options: {
    id: string;
    target: HostTarget;
    paths: WorkerArtifactPaths;
    sessionFile: string;
    task: string;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
  },
): Promise<{ result: WorkerResultFile; details: WorkerToolDetails }> {
  const startedAt = Date.now();
  let lastProgressAt = -PROGRESS_UPDATE_INTERVAL_MS;
  let lastStateAt = -STATE_POLL_INTERVAL_MS;
  let unavailableSince: number | undefined;
  const host = hostForTarget(pi, options.target);
  const details = (status: string): WorkerToolDetails => ({
    id: options.id, target: options.target, artifacts: options.paths,
    sessionFile: options.sessionFile, task: options.task, elapsedMs: Date.now() - startedAt, status,
  });
  const readResult = (): WorkerResultFile | undefined => fs.existsSync(options.paths.resultPath)
    ? parseWorkerResult(fs.readFileSync(options.paths.resultPath, "utf8"), options.paths.resultPath, options.id) : undefined;

  while (true) {
    options.signal?.throwIfAborted();
    const result = readResult();
    if (result) return { result, details: details("finished") };
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs - lastStateAt >= STATE_POLL_INTERVAL_MS) {
      lastStateAt = elapsedMs;
      let state: "running" | "exited" | "missing" | undefined;
      try {
        state = await host.state(options.target, options.signal);
        unavailableSince = undefined;
      } catch (error) {
        options.signal?.throwIfAborted();
        unavailableSince ??= Date.now();
        if (Date.now() - unavailableSince >= STATE_UNAVAILABLE_GRACE_MS) {
          throw new Error(`Could not inspect worker ${options.target.name} (${options.target.host}:${options.target.id}) for five seconds: ${String(error)}\nSession: ${options.sessionFile}`);
        }
      }
      if (state === "exited" || state === "missing") {
        // The child writes its final artifact before exiting. Recheck after native state I/O.
        const final = readResult();
        if (final) return { result: final, details: details("finished") };
        throw new Error(`Worker ${options.target.name} (${options.target.host}:${options.target.id}) ${state} before writing a final result.\nSession: ${options.sessionFile}\nResult: ${options.paths.resultPath}`);
      }
    }
    if (options.onUpdate && elapsedMs - lastProgressAt >= PROGRESS_UPDATE_INTERVAL_MS) {
      lastProgressAt = elapsedMs;
      const status = readWorkerStatus(options.paths.statusPath);
      const matchingStatus = status?.id === options.id ? status : undefined;
      const progress = matchingStatus?.state === "supervised"
        ? [`Worker ${options.target.name} is supervised.`, matchingStatus.supervisionReason,
          "Open the worker and type a message to investigate; use /worker-submit to return its reply or /worker-continue <prompt> to resume automatic completion."].filter(Boolean).join("\n")
        : `Waiting for worker ${options.target.name} (${Math.floor(elapsedMs / 1000)}s elapsed).`;
      const output = await captureWorkerOutput(pi, options.target, 12, options.signal);
      options.onUpdate({
        content: [{ type: "text", text: `${progress}\nSession: ${options.sessionFile}\n\n${output}` }],
        details: details(matchingStatus?.state ?? "waiting"),
      });
    }
    await delay(RESULT_POLL_INTERVAL_MS, undefined, { signal: options.signal });
  }
}

export async function runEphemeralWorker(
  pi: ExtensionAPI,
  options: {
    id: string;
    name: string;
    cwd: string;
    sessionFile: string;
    args: string[];
    paths: WorkerArtifactPaths;
    task: string;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
  },
): Promise<{ result: WorkerResultFile; details: WorkerToolDetails }> {
  const release = claimName(options.name);
  let target: HostTarget | undefined;
  let failure: Error | undefined;
  try {
    if (readTarget(options.name)) throw new Error(`'${options.name}' already exists.`);
    const host = getHost(pi);
    target = await host.start({
      kind: "pi", name: options.name, cwd: options.cwd, sessionFile: options.sessionFile,
      args: options.args, prompt: `/worker-run ${options.paths.requestPath}`, placement: "worker", parent: host.parent(),
    }, options.signal);
    saveTarget(target);
    const output = await waitForWorkerResult(pi, { ...options, target });
    if (output.result.isError) throw new Error(output.result.result);
    return output;
  } catch (error) {
    failure = new Error(appendWorkerMoreInfo(error instanceof Error ? error.message : String(error), options.paths));
    throw failure;
  } finally {
    try {
      if (target) {
        try {
          await hostForTarget(pi, target).close(target);
          removeTarget(target.name);
        } catch (error) {
          throw new Error(appendWorkerMoreInfo([
            failure?.message,
            `Could not close worker ${target.name} (${target.host}:${target.id}): ${String(error)}`,
          ].filter(Boolean).join("\n"), options.paths));
        }
      }
    } finally {
      release();
    }
  }
}
