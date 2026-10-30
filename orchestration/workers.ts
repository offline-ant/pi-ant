import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHost, hostForTarget } from "./host.ts";
import type { HostTarget } from "./host-types.ts";
import { appendWorkerMoreInfo, formatWorkerResult, formatWorkerRetryTime, parseWorkerResult, readWorkerStatus, type WorkerArtifactPaths, type WorkerResultFile, type WorkerStatusFile } from "./worker-frame.ts";
import { createWorkerPreview } from "./worker-preview.ts";

const REGISTRY_DIR = path.join(os.tmpdir(), "pi-orchestration-targets");
const RESULT_POLL_INTERVAL_MS = 250;
const PROGRESS_UPDATE_INTERVAL_MS = 5000;
const STATE_POLL_INTERVAL_MS = 1000;
const STATE_UNAVAILABLE_GRACE_MS = 5000;

interface RegistryEntry {
  target: HostTarget;
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

/**
 * A claim makes one process the only user of a name: `request` for a worker's
 * whole parent request, `operation` for a start or close that changes the
 * registry within seconds. The file names its holder's PID and purpose.
 */
export type ClaimPurpose = "request" | "operation";
interface Claim { pid: number; purpose?: ClaimPurpose; ino: number }
const OPERATION_POLL_MS = 50;

const claimPath = (name: string): string => `${registryPath(name)}.claim`;

function readClaim(file: string): Claim | undefined {
  try {
    const { ino } = fs.statSync(file);
    const [pid, purpose] = fs.readFileSync(file, "utf8").trim().split(/\s+/);
    return { pid: Number(pid), ino, ...(purpose === "request" || purpose === "operation" ? { purpose } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true; // Unreadable holder: never presume it gone.
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** The live holder of a name's claim, after removing one left by a process that no longer exists. */
function liveClaim(name: string): Claim | undefined {
  const file = claimPath(name);
  const claim = readClaim(file);
  if (!claim || processAlive(claim.pid)) return claim;
  // Only that exact stale file: a claim taken since then has another inode.
  if (readClaim(file)?.ino === claim.ino) fs.rmSync(file, { force: true });
  return undefined;
}

export function tryClaimName(name: string, purpose: ClaimPurpose = "request"): (() => void) | undefined {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  const file = claimPath(name);
  for (;;) {
    try {
      fs.writeFileSync(file, `${process.pid} ${purpose}\n`, { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (liveClaim(name)) return undefined;
    }
  }
  let released = false;
  return () => {
    if (released) return;
    fs.unlinkSync(file);
    released = true;
  };
}

const heldError = (name: string): Error =>
  new Error(`'${name}' is already being used by another request (claim: ${claimPath(name)}).`);

export function claimName(name: string): () => void {
  const release = tryClaimName(name);
  if (!release) throw heldError(name);
  return release;
}

/**
 * Claim a name for a registry operation. Tools of one assistant batch run
 * concurrently, so a start may follow a close of the same name that has not
 * finished yet: wait for such operations instead of failing. A worker's request
 * claim lasts its whole run and still fails at once.
 */
export async function claimNameForOperation(name: string, signal?: AbortSignal): Promise<() => void> {
  for (;;) {
    const release = tryClaimName(name, "operation");
    if (release) return release;
    const holder = liveClaim(name);
    if (holder && holder.purpose !== "operation") throw heldError(name);
    await delay(OPERATION_POLL_MS, undefined, { signal });
  }
}

/** A name's target once any start or close of it in progress has finished. */
export async function settledTarget(name: string, signal?: AbortSignal): Promise<HostTarget | undefined> {
  while (liveClaim(name)?.purpose === "operation") await delay(OPERATION_POLL_MS, undefined, { signal });
  return readTarget(name);
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

export interface WorkerToolDetails {
  id: string;
  target: HostTarget;
  artifacts: WorkerArtifactPaths;
  sessionFile: string;
  task: string;
  elapsedMs: number;
  status: string;
  retryAt?: number;
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
  let workerPid: number | undefined;
  const host = hostForTarget(pi, options.target);
  const preview = createWorkerPreview(options.sessionFile);
  const matchingStatus = (): WorkerStatusFile | undefined => {
    const status = readWorkerStatus(options.paths.statusPath);
    return status?.id === options.id ? status : undefined;
  };
  const details = (status: string, retryAt?: number): WorkerToolDetails => ({
    id: options.id, target: options.target, artifacts: options.paths,
    sessionFile: options.sessionFile, task: options.task, elapsedMs: Date.now() - startedAt, status,
    ...(retryAt === undefined ? {} : { retryAt }),
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
      // A worker publishing its PID no longer needs its host, which may be
      // stalled or busy: only the process decides whether it still runs.
      workerPid ??= matchingStatus()?.pid;
      if (workerPid !== undefined) state = processAlive(workerPid) ? "running" : "exited";
      else try {
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
      const status = matchingStatus();
      const retryAt = status?.state === "running" ? status.retryAt : undefined;
      const progress = retryAt !== undefined
        ? [`Worker ${options.target.name} is waiting for Claude five-hour quota; retry scheduled at ${formatWorkerRetryTime(retryAt)}.`,
          "No tools are replayed; parent cancellation stops recovery."].join("\n")
        : status?.state === "waiting"
          ? [`Worker ${options.target.name} is waiting for you.`, status.waitingReason,
            "Open the worker and type a message to continue it, or use /worker-return [text] to hand back now."].filter(Boolean).join("\n")
          : `Worker ${options.target.name} is running (${Math.floor(elapsedMs / 1000)}s elapsed).`;
      options.onUpdate({
        content: [{ type: "text", text: `${progress}\nSession: ${options.sessionFile}\n\n${preview()}` }],
        details: details(retryAt === undefined ? status?.state ?? "running" : "quota-wait", retryAt),
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
    env?: Record<string, string>;
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
      args: options.args, ...(options.env ? { env: options.env } : {}), prompt: `/worker-run ${options.paths.requestPath}`, placement: "worker", parent: host.parent(),
    }, options.signal);
    saveTarget(target);
    const output = await waitForWorkerResult(pi, { ...options, target });
    if (output.result.isError) throw new Error(formatWorkerResult(output.result));
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
