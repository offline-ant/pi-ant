/**
 * agents-d — auto-load AGENTS.d/ context files into model prompt.
 *
 * On every agent start, checks for ./AGENTS.d/ in ctx.cwd. If present:
 *   1. Injects top-level file contents and the full tree structure into the
 *      system prompt for that agent run.
 *   2. Prints a notification saying the context was injected.
 *
 * If the current system prompt already contains this extension's AGENTS.d
 * marker, injection is skipped to prevent duplicate large file content.
 *
 * File loading rules (following the lace context-files.ts pattern):
 *   - Only top-level entries (files and symlinks) in AGENTS.d/ are loaded.
 *   - Subdirectories are shown in the tree structure but not loaded.
 *   - Entries are sorted alphabetically for stable ordering.
 *   - Symlinks are detected and their real paths are shown in both the
 *     <file path> attribute and the tree listing.
 *
 * The injected format uses <file> markers matching the `read` tool output
 * style, which the model already understands from tool results. This avoids
 * introducing a new presentation syntax.
 *
 * Why <file> markers instead of markdown headers + fenced code blocks:
 *   - The model already reads real `read` tool results in <file> format
 *     and its internal training aligns better with this structure.
 *   - Markdown headings with nested code blocks inside the system prompt
 *     introduce ambiguity when the model subsequently uses the `read` tool
 *     itself — it may confuse the auto-loaded content with real tool results.
 *   - <file> markers are unambiguous, parseable, and mirror how the model
 *     already consumes file content during a session.
 *   - The path attribute gives the relpath, matching the `read` tool's
 *     path parameter convention exactly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  readdirSync,
  readFileSync,
  statSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";

const AGENTS_D_CONTEXT_START = "<!-- pi-ant agents-d context start -->";
const AGENTS_D_CONTEXT_END = "<!-- pi-ant agents-d context end -->";

interface FsEntry {
  name: string;
  type: "file" | "dir" | "symlink";
  realpath?: string;
  children?: FsEntry[];
}

/**
 * Resolve the real path of a symlink, returning an absolute path on success
 * or undefined on error.
 */
function resolveRealPath(absPath: string): string | undefined {
  try {
    return realpathSync(absPath);
  } catch {
    return undefined;
  }
}

/**
 * Recursively build a tree structure from AGENTS.d/ entries.
 * Entries are sorted alphabetically.
 *
 * Uses a visited set (resolved real paths) to prevent infinite recursion
 * from circular symlinks.
 */
function scanAgentsD(
  agentsDir: string,
  visited: Set<string> = new Set(),
): FsEntry[] {
  // Resolve real path of agentsDir itself so we can track it.
  // If it's a normal directory, realpathSync returns the same path
  // (or a canonicalized one with symlinks resolved).
  const realDir = resolveRealPath(agentsDir);
  if (realDir !== undefined) {
    if (visited.has(realDir)) return [];
    visited.add(realDir);
  }

  const entries = readdirSync(agentsDir, { withFileTypes: true });
  const result: FsEntry[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absPath = join(agentsDir, entry.name);

    if (entry.isSymbolicLink()) {
      const real = resolveRealPath(absPath);
      let targetType: "file" | "dir" | "symlink" = "symlink";
      let children: FsEntry[] | undefined;
      if (real !== undefined) {
        try {
          const targetStat = statSync(real);
          if (targetStat.isDirectory()) {
            targetType = "dir";
            children = scanAgentsD(real, visited);
          } else if (targetStat.isFile()) {
            targetType = "file";
          }
        } catch {
          // dangling symlink — keep as "symlink"
        }
      }
      result.push({ name: entry.name, type: targetType, realpath: real, children });
    } else if (entry.isDirectory()) {
      const children = scanAgentsD(absPath, visited);
      result.push({ name: entry.name, type: "dir", children });
    } else if (entry.isFile()) {
      result.push({ name: entry.name, type: "file" });
    }
  }
  return result;
}

/**
 * Render a tree structure using the `tree` command convention
 * (same format the model sees from bash tool results).
 * Symlinks show the real path suffix: `name -> /real/path`
 */
function renderTree(entries: FsEntry[], prefix = ""): string {
  const lines: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";

    let label = entry.name;
    if (entry.type === "dir") {
      label += "/";
    }
    if (entry.realpath !== undefined) {
      label += " → " + entry.realpath;
    }

    lines.push(prefix + connector + label);

    if (entry.children && entry.children.length > 0) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      lines.push(renderTree(entry.children, childPrefix));
    }
  }

  return lines.join("\n");
}

/**
 * Load content from all top-level loadable entries in AGENTS.d/ and format
 * them as `<file>` blocks matching the `read` tool output format.
 *
 * Loadable entries: regular files and symlinks whose target is a file.
 * Subdirectories are not loaded (they appear only in the tree listing).
 */
function loadTopLevelContents(agentsDir: string, relBase: string): string {
  const entries = readdirSync(agentsDir, { withFileTypes: true });
  const loadable = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((e) => {
      // Load regular files and symlinks-to-files only
      const absPath = join(agentsDir, e.name);
      if (e.isFile()) return true;
      if (e.isSymbolicLink()) {
        try {
          const real = realpathSync(absPath);
          return statSync(real).isFile();
        } catch {
          return false; // dangling symlink — skip
        }
      }
      return false;
    });

  const blocks: string[] = [];

  for (const entry of loadable) {
    const absPath = join(agentsDir, entry.name);
    const relPath = join(relBase, entry.name);

    let fileAttr = `path="${relPath}"`;
    if (entry.isSymbolicLink()) {
      const real = resolveRealPath(absPath);
      if (real !== undefined) {
        fileAttr = `path="${relPath}" realpath="${real}"`;
      }
    }

    try {
      const content = readFileSync(absPath, "utf-8");
      blocks.push(`<file ${fileAttr}>\n${content}</file>`);
    } catch {
      blocks.push(`<file ${fileAttr}>\n[error reading file]</file>`);
    }
  }

  return blocks.join("\n\n");
}

/**
 * Result from buildAgentsDContext.
 */
interface AgentsDContext {
  systemPromptBlock: string;
  loadedFiles: string[];
  visibleDirs: string[];
  treeBlock: string;
}

/**
 * Build the full AGENTS.d context block for system prompt injection.
 * Returns null if no AGENTS.d/ exists.
 *
 * Output order:
 *   1. Intro block explaining AGENTS.d
 *   2. <file> blocks with content of each top-level loadable entry
 *   3. Tree listing of the full AGENTS.d/ structure
 */
function buildAgentsDContext(cwd: string): AgentsDContext | null {
  const agentsDir = join(cwd, "AGENTS.d");

  try {
    const stats = statSync(agentsDir);
    if (!stats.isDirectory()) return null;
  } catch {
    return null; // does not exist
  }

  const entries = scanAgentsD(agentsDir);
  const contents = loadTopLevelContents(agentsDir, "AGENTS.d");
  const tree = renderTree(entries);
  const treeBlock = `AGENTS.d/\n${tree}`;

  // Collect loaded file names and visible directory names from the entries
  const loadedFiles = entries
    .filter((e) => e.type === "file")
    .map((e) => e.name)
    .sort();
  const visibleDirs = entries
    .filter((e) => e.type === "dir")
    .map((e) => `./${e.name}/`)
    .sort();

  const systemPromptBlock = [
    AGENTS_D_CONTEXT_START,
    "# AGENTS.d context",
    "Top-level files are loaded below; directories appear only in the tree. Symlink targets show their real paths.",
    "",
    contents,
    "",
    "```",
    treeBlock,
    "```",
    AGENTS_D_CONTEXT_END,
  ].join("\n");

  return { systemPromptBlock, loadedFiles, visibleDirs, treeBlock };
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const result = buildAgentsDContext(ctx.cwd);
    if (!result) {
      return; // no AGENTS.d/ directory
    }

    const { systemPromptBlock, loadedFiles, visibleDirs } = result;

    const loadedList =
      loadedFiles.length > 0
        ? loadedFiles.join(", ")
        : "(none)";
    const dirsList =
      visibleDirs.length > 0
        ? visibleDirs.join(", ")
        : "";

    const parts: string[] = [`loaded: ${loadedList}`];
    if (dirsList) parts.push(`dirs: ${dirsList}`);

    if (event.systemPrompt.includes(AGENTS_D_CONTEXT_START)) {
      ctx.ui.notify(
        `AGENTS.d/ already injected; skipped duplicate: ${parts.join("; ")}`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(
      `AGENTS.d/ injected into system prompt: ${parts.join("; ")}`,
      "info",
    );

    return {
      systemPrompt: event.systemPrompt + "\n\n" + systemPromptBlock,
    };
  });
}
