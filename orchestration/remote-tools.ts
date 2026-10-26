import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  detectSupportedImageMimeTypeFromFile,
  type BashOperations,
  type EditOperations,
  type ExtensionContext,
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { expandRemoteHome, type RemoteLocation, type RemoteSession } from "./remote-session.ts";
import { shellQuote, sshExec, sshRun, type SshRunResult } from "./ssh.ts";

/** Script exit statuses reported as Node-style error codes, as the built-in tools expect. */
const STATUS_CODES: Record<number, string> = { 3: "ENOENT", 4: "EACCES", 5: "EISDIR", 7: "ENOEXEC" };
const IMAGE_SNIFF_BYTES = 4100;

function fail(result: SshRunResult, location: RemoteLocation, filePath: string, action: string): void {
  if (result.code === 0) return;
  const code = STATUS_CODES[result.code];
  const detail = result.stderr.trim();
  const error = new Error(`${code ?? `exit status ${result.code}`}: cannot ${action} ${location.destination}:${filePath}${detail ? ` (${detail})` : ""}`) as NodeJS.ErrnoException;
  if (code) error.code = code;
  throw error;
}

function catScript(filePath: string): string {
  return `p=${shellQuote(filePath)}\n[ -e "$p" ] || exit 3\n[ -d "$p" ] && exit 5\n[ -r "$p" ] || exit 4\nexec cat -- "$p"`;
}

/** Pi's own image detection reads a file; give it the remote file's leading bytes. */
async function detectImageMimeType(content: Buffer): Promise<string | null> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-sniff-"));
  try {
    const file = path.join(directory, "head");
    fs.writeFileSync(file, content.subarray(0, IMAGE_SNIFF_BYTES), { mode: 0o600 });
    return await detectSupportedImageMimeTypeFromFile(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function writeRemoteFile(location: RemoteLocation, filePath: string, content: string | Buffer): Promise<void> {
  // Content travels on stdin, so any bytes survive unchanged.
  fail(await sshRun(location.destination, `cat > ${shellQuote(filePath)}`, { stdin: content }), location, filePath, "write");
}

/** One instance per tool call: access, sniffing, and reading share a single transfer. */
export function remoteReadOperations(location: RemoteLocation): ReadOperations {
  const contents = new Map<string, Promise<Buffer>>();
  const fetch = (filePath: string): Promise<Buffer> => {
    let content = contents.get(filePath);
    if (!content) {
      content = sshRun(location.destination, catScript(filePath)).then((result) => {
        fail(result, location, filePath, "read");
        return result.stdout;
      });
      contents.set(filePath, content);
    }
    return content;
  };
  return {
    access: async (filePath) => { await fetch(filePath); },
    readFile: fetch,
    detectImageMimeType: async (filePath) => detectImageMimeType(await fetch(filePath)),
  };
}

export function remoteWriteOperations(location: RemoteLocation): WriteOperations {
  return {
    writeFile: (filePath, content) => writeRemoteFile(location, filePath, content),
    mkdir: async (directory) => fail(await sshRun(location.destination, `mkdir -p -- ${shellQuote(directory)}`), location, directory, "create directory"),
  };
}

export function remoteEditOperations(location: RemoteLocation): EditOperations {
  return {
    access: async (filePath) => fail(await sshRun(location.destination,
      `p=${shellQuote(filePath)}\n[ -e "$p" ] || exit 3\n[ -d "$p" ] && exit 5\n{ [ -r "$p" ] && [ -w "$p" ]; } || exit 4`), location, filePath, "edit"),
    readFile: async (filePath) => {
      const result = await sshRun(location.destination, catScript(filePath));
      fail(result, location, filePath, "read");
      return result.stdout;
    },
    writeFile: (filePath, content) => writeRemoteFile(location, filePath, content),
  };
}

/** One instance per tool call: a listing records entry types, so ls needs no per-entry round trip. */
export function remoteLsOperations(location: RemoteLocation): LsOperations {
  const directories = new Map<string, boolean>();
  const probe = async (filePath: string): Promise<boolean | undefined> => {
    if (directories.has(filePath)) return directories.get(filePath);
    const result = await sshRun(location.destination,
      `p=${shellQuote(filePath)}\nif [ -d "$p" ]; then echo d; elif [ -e "$p" ] || [ -L "$p" ]; then echo f; else exit 3; fi`);
    if (result.code === 3) return undefined;
    fail(result, location, filePath, "inspect");
    const isDirectory = result.stdout.toString().trim() === "d";
    directories.set(filePath, isDirectory);
    return isDirectory;
  };
  return {
    exists: async (filePath) => await probe(filePath) !== undefined,
    stat: async (filePath) => {
      const isDirectory = await probe(filePath);
      if (isDirectory === undefined) fail({ code: 3, stdout: Buffer.alloc(0), stderr: "" }, location, filePath, "inspect");
      return { isDirectory: () => isDirectory === true };
    },
    readdir: async (directory) => {
      const result = await sshRun(location.destination, [
        `cd -- ${shellQuote(directory)} || exit 3`,
        "shopt -s nullglob dotglob",
        `for e in *; do if [ -d "$e" ]; then printf 'd%s\\0' "$e"; else printf 'f%s\\0' "$e"; fi; done`,
      ].join("\n"));
      fail(result, location, directory, "list");
      const names: string[] = [];
      for (const entry of result.stdout.toString().split("\0").filter(Boolean)) {
        const name = entry.slice(1);
        directories.set(path.posix.join(directory, name), entry[0] === "d");
        names.push(name);
      }
      return names;
    },
  };
}

export function remoteFindOperations(location: RemoteLocation): FindOperations {
  return {
    exists: async (filePath) => (await sshRun(location.destination, `[ -e ${shellQuote(filePath)} ]`)).code === 0,
    glob: async (pattern, cwd, options) => {
      // Like Pi's fd invocation: a pattern containing a slash matches at any depth.
      const effective = pattern.includes("/") && !pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**"
        ? `**/${pattern}` : pattern;
      const result = await sshRun(location.destination, [
        "command -v rg >/dev/null || { echo 'rg (ripgrep) is not installed on the remote host' >&2; exit 7; }",
        `cd -- ${shellQuote(cwd)} || exit 3`,
        `rg --files --hidden --no-messages --glob ${shellQuote(effective)} ${options.ignore.map((glob) => `--glob ${shellQuote(`!${glob}`)}`).join(" ")} | head -n ${Math.max(1, options.limit)}`,
      ].join("\n"));
      fail(result, location, cwd, "search");
      return result.stdout.toString().split("\n").filter(Boolean);
    },
  };
}

export function remoteBashOperations(location: RemoteLocation): BashOperations {
  return { exec: (command, cwd, options) => sshExec(location.destination, command, cwd, options) };
}

/** Built-in tools resolve relative paths against ctx.cwd, which stays the local directory. */
function withCwd<T extends ExtensionContext>(ctx: T, cwd: string): T {
  return new Proxy(ctx, { get: (target, key) => key === "cwd" ? cwd : Reflect.get(target, key, target) });
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

function remoteTool(
  remote: RemoteSession,
  base: AnyToolDefinition,
  create: (location: RemoteLocation) => AnyToolDefinition,
  afterExecute?: (location: RemoteLocation, fullOutputPath: string | undefined) => Promise<void>,
): AnyToolDefinition {
  return {
    ...base,
    async execute(toolCallId, params: Record<string, unknown>, signal, onUpdate, ctx) {
      const location = await remote.location(signal);
      const args = typeof params.path === "string" ? { ...params, path: expandRemoteHome(params.path, location.home) } : params;
      let fullOutputPath: string | undefined;
      try {
        return await create(location).execute(toolCallId, args, signal, (update) => {
          fullOutputPath = (update.details as { fullOutputPath?: string } | undefined)?.fullOutputPath ?? fullOutputPath;
          onUpdate?.(update);
        }, withCwd(ctx, location.cwd));
      } finally {
        await afterExecute?.(location, fullOutputPath);
      }
    },
  };
}

/** Tools with the built-in contracts whose filesystem and process operations run at the session's remote target. */
export function createRemoteToolDefinitions(remote: RemoteSession, localCwd: string): AnyToolDefinition[] {
  const bashOptions = { exposeSessionEnvironment: false };
  return [
    remoteTool(remote, createReadToolDefinition(localCwd), (location) => createReadToolDefinition(location.cwd, { operations: remoteReadOperations(location) })),
    remoteTool(remote, createWriteToolDefinition(localCwd), (location) => createWriteToolDefinition(location.cwd, { operations: remoteWriteOperations(location) })),
    remoteTool(remote, createEditToolDefinition(localCwd), (location) => createEditToolDefinition(location.cwd, { operations: remoteEditOperations(location) })),
    remoteTool(remote, createLsToolDefinition(localCwd), (location) => createLsToolDefinition(location.cwd, { operations: remoteLsOperations(location) })),
    remoteTool(remote, createFindToolDefinition(localCwd), (location) => createFindToolDefinition(location.cwd, { operations: remoteFindOperations(location) })),
    remoteTool(remote, createBashToolDefinition(localCwd, bashOptions),
      (location) => createBashToolDefinition(location.cwd, { ...bashOptions, operations: remoteBashOperations(location) }),
      // Truncated output names a full-output file; place it where remote tools can read it.
      async (location, fullOutputPath) => {
        if (!fullOutputPath || !fs.existsSync(fullOutputPath)) return;
        await sshRun(location.destination, `mkdir -p -- ${shellQuote(path.posix.dirname(fullOutputPath))} && cat > ${shellQuote(fullOutputPath)}`,
          { stdin: fs.readFileSync(fullOutputPath) }).catch(() => undefined);
      }),
    unavailableTool(createGrepToolDefinition(localCwd),
      `grep runs ripgrep on this machine and is unavailable while tools run on ${remote.spec} over SSH. Use rg through bash instead.`),
  ];
}

function unavailableTool(base: AnyToolDefinition, reason: string): AnyToolDefinition {
  return {
    ...base,
    description: "Unavailable while tools run on a remote host over SSH. Use rg through bash instead.",
    async execute() { throw new Error(reason); },
  };
}

/** `!` commands typed by the user run at the remote working directory. */
export function remoteUserBashOperations(remote: RemoteSession): BashOperations {
  return {
    exec: async (command, _localCwd, options) => {
      const location = await remote.location(options.signal);
      return sshExec(location.destination, command, location.cwd, options);
    },
  };
}
