/**
 * Raw panel output capture, shared by all terminal hosts.
 *
 * Hosts expose rendered screen snapshots, which lose output that scrolls away
 * between reads and drop terminal control sequences. Panels therefore run their
 * command under `script`, a PTY relay that appends every byte the program
 * writes to a private log. That log gives exact incremental output and keeps
 * OSC 133 shell-integration marks (prompt start `A`, input end `B`, command start
 * `C`, command end `D;<status>`), which shells emit around each command, also
 * through ssh.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Shell integration files emitting OSC 133 marks, for shells that do not emit them natively. */
export const SHELL_INTEGRATION = {
  bash: fileURLToPath(new URL("./shell/osc133.bash", import.meta.url)),
  fish: fileURLToPath(new URL("./shell/osc133.fish", import.meta.url)),
};
export const SHELL_INTEGRATION_HINT = "fish 4+ emits them natively; for bash or fish 3, source "
  + `${SHELL_INTEGRATION.bash} from ~/.bashrc or ${SHELL_INTEGRATION.fish} from ~/.config/fish/config.fish, copying the file first on remote hosts.`;

const quote = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`;
/** util-linux `script` writes these lines around the captured output, even with -q. */
const HEADER_PREFIX = "Script started on ";
const TRAILER_RE = /^Script done on .*\[COMMAND_EXIT_CODE="(\d+)"\]$/;
const MARK_RE = /\x1b\]133;([ABCD])([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const SCAN_CHUNK = 1024 * 1024;
const MAX_BACKWARD_SCAN = 64 * 1024 * 1024;
/** Bound on log bytes examined per forward scan, and on command output read for a result. */
const READ_LIMIT = 4 * 1024 * 1024;

export interface PanelOutput {
  dir: string;
  log: string;
}

export function createPanelOutput(): PanelOutput {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-panel-output-"));
  const log = path.join(dir, "output.log");
  fs.writeFileSync(log, "", { mode: 0o600 });
  return { dir, log };
}

export function removePanelOutput(log: string | undefined): void {
  if (log) fs.rmSync(path.dirname(log), { recursive: true, force: true });
}

/**
 * Wrap a panel argv so its terminal output is also appended to `log`.
 * util-linux `script -c` runs its command with `$SHELL`, which may be fish or
 * another shell with different quoting, so the relay runs /bin/sh and the
 * command restores the original SHELL before exec.
 */
export function capturedArgv(argv: string[], log: string, platform = process.platform): string[] {
  if (platform === "darwin") return ["script", "-q", "-F", log, ...argv];
  const command = `if [ "\${PI_PANEL_SHELL+x}" ]; then SHELL=$PI_PANEL_SHELL; unset PI_PANEL_SHELL; else unset SHELL; fi; exec ${argv.map(quote).join(" ")}`;
  return ["/bin/sh", "-c",
    `if [ "\${SHELL+x}" ]; then export PI_PANEL_SHELL="$SHELL"; fi; SHELL=/bin/sh exec script -qfec "$2" "$1"`,
    "pi-panel", log, command];
}

export type PromptMarkKind = "A" | "B" | "C" | "D";
export interface PromptMark {
  kind: PromptMarkKind;
  /** Byte offset just after the mark. */
  end: number;
  /** Exit status of a `D` mark, or for the latest mark, of the nearest preceding `D` in the same output. */
  status?: number;
  /** Command line of a `C` mark, when the shell reports it (fish's `cmdline_url`). */
  command?: string;
}

function commandLine(params: string): string | undefined {
  const encoded = /;cmdline_url=([^;]*)/.exec(params)?.[1];
  if (encoded === undefined) return undefined;
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

/** Marks in `bytes`, decoded as latin1 so string indices are byte offsets. */
function marksIn(bytes: Buffer, base: number): PromptMark[] {
  const marks: PromptMark[] = [];
  for (const match of bytes.toString("latin1").matchAll(MARK_RE)) {
    const kind = match[1] as PromptMarkKind;
    const status = kind === "D" ? Number.parseInt(match[2].replace(/^;/, ""), 10) : NaN;
    const command = kind === "C" ? commandLine(match[2]) : undefined;
    marks.push({ kind, end: base + match.index + match[0].length,
      ...(Number.isFinite(status) ? { status } : {}), ...(command !== undefined ? { command } : {}) });
  }
  return marks;
}

/** The latest OSC 133 mark before `end`, scanning backwards in bounded chunks. */
export function lastPromptMark(log: string, end: number): PromptMark | undefined {
  const fd = fs.openSync(log, "r");
  try {
    let stop = end;
    while (stop > 0 && end - stop < MAX_BACKWARD_SCAN) {
      // Overlap chunks so a mark split across a boundary is still seen whole.
      const start = Math.max(0, stop - SCAN_CHUNK);
      const length = Math.min(end, stop + 256) - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const marks = marksIn(buffer, start);
      const mark = marks.at(-1);
      if (mark) return { ...mark, status: marks.findLast((candidate) => candidate.kind === "D")?.status };
      stop = start;
    }
    return undefined;
  } finally { fs.closeSync(fd); }
}

/**
 * Whether input sent at offset `input` reaches a shell that reports its prompt.
 * - `prompt`: marks followed the input, or the last mark before it left a shell at its prompt.
 * - `program`: the input went to a command a marked shell started (`C` with no later mark),
 *   such as ssh to a host whose shell emits no marks, a REPL, or an unmarked nested shell.
 * - `none`: the panel has shown no marks at all.
 * Without `input`, the panel's current state is classified.
 */
export type PromptReporting =
  | { kind: "prompt" }
  | { kind: "program"; command?: string; mark: number }
  | { kind: "none" };

export function promptReporting(log: string, end: number, input = end): PromptReporting {
  const latest = lastPromptMark(log, end);
  if (!latest) return { kind: "none" };
  if (latest.end > input || latest.kind !== "C") return { kind: "prompt" };
  return { kind: "program", mark: latest.end, ...(latest.command !== undefined ? { command: latest.command } : {}) };
}

/** Why a wait without match cannot see this input finish, or undefined when it can. */
export function promptWarning(reporting: PromptReporting): string | undefined {
  if (reporting.kind === "prompt") return undefined;
  const consequence = "so wait without match cannot tell when input is done";
  const where = reporting.kind === "program"
    ? `Input goes to ${reporting.command ? `\`${reporting.command}\`` : "a running command"}, which shows no OSC 133 prompt marks (for example ssh to a host without shell integration), ${consequence}; it ends only when that command exits.`
    : `No OSC 133 prompt marks have appeared in this panel yet, ${consequence}; it ends only when the panel's command exits.`;
  return `Warning: ${where} Use wait with match, or install shell integration where that shell runs: ${SHELL_INTEGRATION_HINT}`;
}

/** Terminal output as plain text: control sequences removed, carriage-return overwrites resolved. */
export function plainLine(raw: string): string {
  const text = raw
    .replace(/\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]|\x1b[ -/]+[0-~]|\x1b[=>78]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (char) => char === "\r" ? char : "")
    .replace(/\r+$/, "");
  const segments = text.split("\r");
  return segments.findLast((segment) => segment.trim() !== "") ?? "";
}

export interface OutputLine {
  text: string;
  /** Byte offset just after the line, including its newline when complete. */
  end: number;
}

export interface OutputChunk {
  lines: OutputLine[];
  /** Text after the final newline, not yet a complete line. */
  partial?: OutputLine;
  marks: PromptMark[];
  /** Exit status recorded by `script` when the captured command ended. */
  exitStatus?: number;
  /** Offset of the first byte not consumed as a complete line. */
  next: number;
}

/** Read output from `start` up to `end`, line-wise. A trailing partial line is reported but not consumed. */
export function readOutput(log: string, start: number, end: number): OutputChunk {
  const chunk: OutputChunk = { lines: [], marks: [], next: start };
  if (end <= start) return chunk;
  const buffer = Buffer.alloc(end - start);
  const fd = fs.openSync(log, "r");
  try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
  let lineStart = 0;
  while (lineStart < buffer.length) {
    const newline = buffer.indexOf(0x0a, lineStart);
    const lineEnd = newline < 0 ? buffer.length : newline + 1;
    const bytes = buffer.subarray(lineStart, newline < 0 ? lineEnd : newline);
    const offset = start + lineStart;
    chunk.marks.push(...marksIn(bytes, offset));
    const text = plainLine(bytes.toString("utf8"));
    if (newline < 0) {
      if (text !== "") chunk.partial = { text, end: start + lineEnd };
      break;
    }
    lineStart = lineEnd;
    chunk.next = start + lineEnd;
    if (offset === 0 && text.startsWith(HEADER_PREFIX)) continue;
    const trailer = TRAILER_RE.exec(text);
    if (trailer) { chunk.exitStatus = Number(trailer[1]); continue; }
    chunk.lines.push({ text, end: start + lineEnd });
  }
  return chunk;
}

export type ScanOutcome =
  | { kind: "matched"; line: string }
  | { kind: "prompt"; status?: number };

export interface OutputScan {
  /** The first match, or command end after `promptAfter`, and the offset just after it. */
  found?: { outcome: ScanOutcome; end: number };
  /** Plain lines examined, through the found line or mark. */
  lines: string[];
  /** Next unexamined offset. */
  next: number;
  /** Whether output remains beyond this bounded read. */
  more: boolean;
  /** Exit status recorded by `script` when the captured command ended. */
  exitStatus?: number;
}

/**
 * Examine log output from `offset` for the first line matching `match` or, after
 * `promptAfter`, the first command end: `D;<status>`, or a prompt start `A` without
 * one (fish's empty command line, or a nested shell's first prompt, such as over ssh).
 */
export function scanOutput(log: string, offset: number, match: RegExp | undefined, promptAfter: number | undefined): OutputScan {
  const size = fs.statSync(log).size;
  if (size < offset) offset = 0;
  const end = Math.min(size, offset + READ_LIMIT);
  const chunk = readOutput(log, offset, end);
  // A single line longer than the read limit is examined in pieces.
  if (chunk.next === offset && end < size && chunk.partial) {
    chunk.lines.push(chunk.partial);
    chunk.partial = undefined;
    chunk.next = end;
  }
  const candidates: OutputLine[] = [...chunk.lines, ...(chunk.partial ? [chunk.partial] : [])];
  let found: OutputScan["found"];
  if (match) {
    const line = candidates.find((candidate) => match.test(candidate.text));
    if (line) found = { outcome: { kind: "matched", line: line.text }, end: line.end };
  }
  if (promptAfter !== undefined) {
    const done = chunk.marks.find((mark) => mark.end > promptAfter && (mark.kind === "A" || mark.kind === "D"));
    if (done && (!found || done.end < found.end)) {
      found = { outcome: { kind: "prompt", ...(done.status !== undefined ? { status: done.status } : {}) }, end: done.end };
    }
  }
  const stop = found?.end;
  const lines = stop !== undefined ? candidates.filter((line) => line.end <= stop) : chunk.lines;
  return {
    ...(found ? { found } : {}),
    lines: lines.map((line) => line.text),
    next: found ? Math.max(found.end, chunk.next) : chunk.next,
    more: end < size,
    ...(chunk.exitStatus !== undefined ? { exitStatus: chunk.exitStatus } : {}),
  };
}

/**
 * Plain output of a command typed at offset `input` that ended at `end`: from its
 * command start `C` (omitting the echoed command line), bounded to the last bytes.
 */
export function commandOutput(log: string, input: number, end: number): string {
  const start = Math.max(input, end - READ_LIMIT);
  const buffer = Buffer.alloc(end - start);
  const fd = fs.openSync(log, "r");
  try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
  const commandStart = marksIn(buffer, start).find((mark) => mark.kind === "C");
  // Without a command start the line was empty, unless the read cut it off.
  const body = commandStart ? buffer.subarray(commandStart.end - start)
    : start > input ? buffer.subarray(buffer.indexOf(0x0a) + 1)
    : Buffer.alloc(0);
  const lines = body.toString("utf8").split("\n").map(plainLine);
  while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
  return lines.join("\n");
}

/** Per-panel wait progress, shared by every session using the panel. */
export interface WaitCursor {
  /** Output before this offset was already examined by a wait or preceded the latest input. */
  cursor: number;
  /** Log size when input was last sent through panel-send. */
  input?: number;
}

const cursorPath = (log: string): string => path.join(path.dirname(log), "wait.json");

export function readCursor(log: string): WaitCursor {
  try { return JSON.parse(fs.readFileSync(cursorPath(log), "utf8")) as WaitCursor; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cursor: 0 };
    throw error;
  }
}

export function writeCursor(log: string, value: WaitCursor): void {
  const file = cursorPath(log);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Input starts a new command: later waits examine only the output it causes. */
export function recordInput(log: string): number {
  const size = fs.statSync(log).size;
  writeCursor(log, { cursor: size, input: size });
  return size;
}
