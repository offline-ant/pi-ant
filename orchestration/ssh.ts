import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * One multiplexed OpenSSH connection per destination, shared by every Pi
 * process of this user: the first call starts a ControlPersist master, later
 * calls reuse it. Remote login shells vary (fish, zsh, bash), so each remote
 * command is a fixed bootstrap that only contains characters every shell
 * passes through unchanged; the real POSIX script travels base64-encoded and
 * runs under bash.
 */

const CONTROL_PERSIST_SECONDS = 600;
/** sshd hands the remote command to the login shell as one argument; Linux limits one argument to 128 KiB. */
const MAX_REMOTE_COMMAND_BYTES = 120_000;
/** After the remote command reports its status, inherited stdout of background descendants is not awaited. */
const EXIT_DRAIN_MS = 500;
/** After asking the remote side to stop a command, wait this long before dropping the local client. */
const STOP_GRACE_MS = 3000;
const EXIT_MARKER = /^PI_REMOTE_EXIT (\d+)$/m;

/** The SSH transport failed (OpenSSH exit status 255), as opposed to a remote command failing. */
export class SshError extends Error {
  override name = "SshError";
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A remote path as a shell word, expanding a leading `~` to the remote home directory. */
export function remotePathWord(value: string): string {
  if (value === "~") return `"$HOME"`;
  if (value.startsWith("~/")) return `"$HOME"/${shellQuote(value.slice(2))}`;
  return shellQuote(value);
}

/** Private per-user directory for control sockets; refuses a directory others could use. */
export function sshControlDirectory(): string {
  const uid = process.getuid?.() ?? 0;
  const directory = path.join(os.tmpdir(), `pi-ssh-${uid}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(`SSH control directory ${directory} must be a private (0700) directory owned by this user.`);
  }
  return directory;
}

export function sshOptions(): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ControlMaster=auto",
    "-o", `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
    // %C hashes the connection identity, keeping socket paths short and per target.
    "-o", `ControlPath=${path.join(sshControlDirectory(), "%C")}`,
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "LogLevel=ERROR",
  ];
}

export function validateDestination(destination: string): string {
  if (!destination || destination.startsWith("-") || /[\s\u0000-\u001f\u007f]/.test(destination)) {
    throw new Error(`Invalid SSH destination '${destination}'.`);
  }
  return destination;
}

/** The remote command for a bash script, independent of the remote login shell's syntax. */
export function remoteCommand(script: string): string {
  const encoded = Buffer.from(script).toString("base64");
  const command = `exec bash -c 'eval "$(printf %s ${encoded} | base64 -d)"'`;
  if (command.length > MAX_REMOTE_COMMAND_BYTES) {
    throw new Error(`Remote command is too large for SSH (${command.length} bytes encoded, limit ${MAX_REMOTE_COMMAND_BYTES}). Write long scripts to a file first.`);
  }
  return command;
}

/** Argv for an interactive command in a terminal panel. */
export function remoteTerminalArgv(destination: string, cwd: string, command: string): string[] {
  const script = `cd -- ${shellQuote(cwd)} || exit 1\nexec bash -l -c ${shellQuote(command)}`;
  return ["ssh", ...sshOptions(), "-t", validateDestination(destination), remoteCommand(script)];
}

function transportError(destination: string, stderr: string): SshError {
  return new SshError(`SSH connection to ${destination} failed: ${stderr.trim() || "ssh exited with status 255"}`);
}

export interface SshRunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Run a short bash script remotely and collect its output. Transport failures throw SshError. */
export function sshRun(
  destination: string,
  script: string,
  options: { stdin?: Buffer | string; signal?: AbortSignal } = {},
): Promise<SshRunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    const child = spawn("ssh", [...sshOptions(), "-T", validateDestination(destination), remoteCommand(script)], {
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin);
    }
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new SshError(`Could not run ssh for ${destination}: ${error.message}`));
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) reject(new Error("Operation aborted"));
      else if (code === 255 || code === null) reject(transportError(destination, stderr));
      else resolve({ code, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

/**
 * Run a bash tool command remotely, streaming combined output. Without a tty a
 * remote command survives the local ssh client, so it runs in its own process
 * group under a watchdog: closing ssh's stdin (Escape, timeout, or this process
 * dying) makes the watchdog terminate the whole group. The exit status arrives
 * on stderr, which carries nothing else, so a missing status means the
 * connection failed rather than the command.
 */
export function sshExec(
  destination: string,
  command: string,
  cwd: string,
  options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<{ exitCode: number | null }> {
  const script = [
    "set -m",
    `cd -- ${shellQuote(cwd)} 2>&1 || { printf 'PI_REMOTE_EXIT 1\\n' >&2; exit 1; }`,
    `bash -c ${shellQuote(command)} </dev/null 2>&1 &`,
    "child=$!",
    `{ cat >/dev/null; kill -TERM -- -"$child" 2>/dev/null; sleep 2; kill -KILL -- -"$child" 2>/dev/null; } &`,
    "watch=$!",
    `wait "$child"; status=$?`,
    `kill -- -"$watch" 2>/dev/null`,
    `printf 'PI_REMOTE_EXIT %d\\n' "$status" >&2`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ssh", [...sshOptions(), "-T", validateDestination(destination), remoteCommand(script)], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let stderr = "";
    let exitCode: number | undefined;
    let stopReason: "aborted" | "timeout" | undefined;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      options.signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    const stop = (reason: "aborted" | "timeout") => {
      if (stopReason || exitCode !== undefined) return;
      stopReason = reason;
      child.stdin?.end();
      timers.push(setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS));
    };
    const onAbort = () => stop("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeout !== undefined && options.timeout > 0) {
      timers.push(setTimeout(() => stop("timeout"), options.timeout * 1000));
    }
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => { if (!settled) options.onData(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = EXIT_MARKER.exec(stderr);
      if (match && exitCode === undefined && !stopReason) {
        exitCode = Number(match[1]);
        // Background descendants may keep stdout open; stop waiting for it shortly.
        timers.push(setTimeout(() => {
          child.kill();
          finish(() => resolve({ exitCode: exitCode! }));
        }, EXIT_DRAIN_MS));
      }
    });
    child.on("error", (error) => finish(() => reject(new SshError(`Could not run ssh for ${destination}: ${error.message}`))));
    child.on("close", () => finish(() => {
      if (stopReason === "aborted") reject(new Error("aborted"));
      else if (stopReason === "timeout") reject(new Error(`timeout:${options.timeout}`));
      else if (exitCode !== undefined) resolve({ exitCode });
      else reject(transportError(destination, stderr));
    }));
  });
}
