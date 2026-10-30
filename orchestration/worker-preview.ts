import * as fs from "node:fs";
import { truncateTail } from "@earendil-works/pi-coding-agent";

const PREVIEW_LINES = 12;
const PREVIEW_BYTES = 8192;
/** One tool call's arguments in a preview line. */
const ARGUMENTS_CHARS = 120;
/** Only the file's tail is read: an entry can be arbitrarily large. */
const TAIL_BYTES = 256 * 1024;

function fileSize(file: string): number {
  try { return fs.statSync(file).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function readRange(file: string, from: number, to: number): string {
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(to - from);
    return buffer.toString("utf8", 0, fs.readSync(handle, buffer, 0, buffer.length, from));
  } finally { fs.closeSync(handle); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

function renderEntry(line: string): string[] {
  let entry: unknown;
  // The first and last lines of a tail can be fragments of larger entries.
  try { entry = JSON.parse(line); } catch { return []; }
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return [];
  const { role, content } = entry.message;
  if (role === "user") return textOf(content).trim().split("\n").filter(Boolean).map((text) => `> ${text}`);
  if (role !== "assistant") return [];
  const calls = (Array.isArray(content) ? content : []).flatMap((block) => {
    if (!isRecord(block) || block.type !== "toolCall") return [];
    return [`${String(block.name)} ${JSON.stringify(block.arguments ?? {}).slice(0, ARGUMENTS_CHARS)}`];
  });
  return [...textOf(content).trim().split("\n").filter(Boolean), ...calls];
}

/**
 * Bounded preview of what a worker appends to its session file, independent of
 * its host. A `do` session starts with the inherited conversation, so only bytes
 * added after this call count; a file that shrank was rewritten and restarts.
 */
export function createWorkerPreview(sessionFile: string): () => string {
  let start = fileSize(sessionFile);
  return () => {
    const size = fileSize(sessionFile);
    if (size < start) start = 0;
    if (size === start) return "(no output yet)";
    const from = Math.max(start, size - TAIL_BYTES);
    const lines = readRange(sessionFile, from, size).split("\n").flatMap(renderEntry);
    if (lines.length === 0) return "(no text output yet)";
    return truncateTail(lines.join("\n"), { maxLines: PREVIEW_LINES, maxBytes: PREVIEW_BYTES }).content;
  };
}
