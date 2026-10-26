import * as path from "node:path";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { RemoteLocation } from "./remote-session.ts";
import { shellQuote, sshRun } from "./ssh.ts";

/** Pi's per-directory context file candidates, first match wins. */
const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
export const REMOTE_SECTION = "remote";
export const AGENTS_D_SECTION = "agents_d";

export interface RemoteContext {
  /** Project context files from the remote cwd and its ancestors, outermost first. */
  contextFiles: Array<{ path: string; content: string }>;
  /** Top-level AGENTS.d files, outermost directory first. */
  agentsFiles: Array<{ path: string; content: string }>;
  /** Every AGENTS.d entry, directories with a trailing slash. */
  agentsEntries: string[];
}

/**
 * Collect remote instructions in one round trip, following Pi's AGENTS.md
 * ancestor traversal and pi-ant's AGENTS.d rules (top-level files load, deeper
 * entries are listed). Content travels base64-encoded, one record per line.
 */
export async function loadRemoteContext(location: RemoteLocation, signal?: AbortSignal): Promise<RemoteContext> {
  const script = [
    `d=${shellQuote(location.cwd)}`,
    "dirs=()",
    `while :; do dirs=("$d" "\${dirs[@]}"); [ "$d" = / ] && break; d=$(dirname -- "$d"); done`,
    `encode() { base64 < "$1" | tr -d '\\n'; }`,
    `for d in "\${dirs[@]}"; do`,
    `  for n in ${CONTEXT_FILE_NAMES.join(" ")}; do f="\${d%/}/$n"; if [ -f "$f" ]; then printf 'C\\t%s\\t' "$f"; encode "$f"; printf '\\n'; break; fi; done`,
    `  a="\${d%/}/AGENTS.d"`,
    `  [ -d "$a" ] || continue`,
    "  shopt -s nullglob dotglob",
    `  for f in "$a"/*; do [ -f "$f" ] && { printf 'F\\t%s\\t' "$f"; encode "$f"; printf '\\n'; }; done`,
    `  find "$a" -mindepth 1 | LC_ALL=C sort | while IFS= read -r e; do if [ -d "$e" ]; then printf 'E\\t%s/\\n' "$e"; else printf 'E\\t%s\\n' "$e"; fi; done`,
    "done",
  ].join("\n");
  const result = await sshRun(location.destination, script, { signal });
  if (result.code !== 0) throw new Error(`Could not load project context from ${location.destination}: ${result.stderr.trim() || `exit status ${result.code}`}`);
  const context: RemoteContext = { contextFiles: [], agentsFiles: [], agentsEntries: [] };
  for (const line of result.stdout.toString().split("\n")) {
    const [kind, filePath, encoded] = line.split("\t");
    if (kind === "C") context.contextFiles.push({ path: filePath, content: Buffer.from(encoded ?? "", "base64").toString("utf8").replace(/^\uFEFF/, "") });
    else if (kind === "F") context.agentsFiles.push({ path: filePath, content: Buffer.from(encoded ?? "", "base64").toString("utf8") });
    else if (kind === "E" && filePath) context.agentsEntries.push(filePath);
  }
  return context;
}

function relative(location: RemoteLocation, filePath: string): string {
  const trailing = filePath.endsWith("/") ? "/" : "";
  return (path.posix.relative(location.cwd, filePath) || ".") + trailing;
}

export function renderRemoteAgentsD(location: RemoteLocation, context: RemoteContext): string | undefined {
  if (context.agentsEntries.length === 0) return undefined;
  return [
    "# AGENTS.d context",
    `Loaded from ${location.destination}. Ancestor directories are loaded outermost first, ending with the current directory. Paths are relative to the current directory. Top-level files are loaded below; deeper entries appear only in the listing.`,
    "",
    context.agentsFiles.map((file) => `<file path="${relative(location, file.path)}">\n${file.content}</file>`).join("\n\n"),
    "",
    "```",
    context.agentsEntries.map((entry) => relative(location, entry)).join("\n"),
    "```",
  ].join("\n");
}

export function remoteSectionText(location: RemoteLocation): string {
  return [
    `Tools run on the remote host ${location.destination} over SSH, in ${location.cwd}.`,
    "read, write, edit, bash, ls, find and the user's ! commands access only that host's files and processes; paths are remote paths and ~ is the remote home.",
    "Pi itself, its session, models, browser and web tools run on the local machine; local paths mentioned elsewhere in this prompt (such as Pi documentation) are not reachable through these tools.",
    "The grep tool is unavailable; use rg through bash.",
  ].join("\n");
}

/**
 * Describe the remote environment instead of the local one: the cwd section
 * shows the remote directory, local project files and skills give way to the
 * remote project's instructions, and global user instructions stay.
 */
export function applyRemotePrompt(
  options: Required<Pick<BuildSystemPromptOptions, "cwd" | "contextFiles" | "skills" | "sections">>,
  localCwd: string,
  location: RemoteLocation,
  context: RemoteContext,
): void {
  // Pi loads project files from the local cwd and its ancestors; anything else is global (agent directory).
  const local = path.resolve(localCwd);
  const isLocalProjectFile = (file: string) => {
    const directory = path.dirname(path.resolve(file));
    return local === directory || local.startsWith(directory === path.sep ? directory : `${directory}${path.sep}`);
  };
  options.cwd = location.cwd;
  options.contextFiles = [
    ...options.contextFiles.filter((file) => !isLocalProjectFile(file.path)),
    ...context.contextFiles.map((file) => ({ path: `${location.destination}:${file.path}`, content: file.content })),
  ];
  // Skill files are local; remote tools cannot read them.
  options.skills = [];
  options.sections[REMOTE_SECTION] = remoteSectionText(location);
  const agentsD = renderRemoteAgentsD(location, context);
  if (agentsD) options.sections[AGENTS_D_SECTION] = agentsD;
  else delete options.sections[AGENTS_D_SECTION];
}
