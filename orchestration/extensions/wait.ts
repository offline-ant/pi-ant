import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hostForTarget } from "../host.ts";
import type { HostTarget } from "../host-types.ts";
import { capturedExitStatus, lastPromptMark, promptReporting, promptWarning, readCursor, scanOutput, SHELL_INTEGRATION_HINT, writeCursor, type PromptMark, type ScanOutcome } from "../panel-output.ts";
import { renderToolCall } from "../tool-call.ts";
import { readTarget, validateName } from "../workers.ts";

const POLL_MS = 500;
const STATE_POLL_MS = 2000;
const PROGRESS_MS = 5000;
const TAIL_LINES = 40;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

type Outcome =
  | ScanOutcome
  | { kind: "exited"; status?: number }
  | { kind: "timeout" };

interface WaitDetails {
  source: string;
  /** Absent in progress updates. */
  outcome?: Outcome["kind"];
  elapsedMs: number;
  status?: number;
  line?: string;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return minutes ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

function compile(match: string | undefined): RegExp | undefined {
  if (match === undefined) return undefined;
  try { return new RegExp(match); }
  catch (error) { throw new Error(`Invalid match regex: ${error instanceof Error ? error.message : String(error)}`); }
}

function fileSize(file: string): number {
  return fs.statSync(file).size;
}

/** Output lines examined so far, bounded to the tail shown in results. */
class Tail {
  lines: string[] = [];
  push(text: string): void {
    this.lines.push(text);
    if (this.lines.length > TAIL_LINES) this.lines.shift();
  }
  text(): string {
    return truncateTail(this.lines.join("\n"), { maxLines: TAIL_LINES, maxBytes: 8192 }).content || "(no new output)";
  }
}

/** Scan output from `offset`, keeping the examined lines in `tail`. */
function scan(log: string, offset: number, regex: RegExp | undefined, promptAfter: number | undefined, tail: Tail) {
  const result = scanOutput(log, offset, regex, promptAfter);
  for (const line of result.lines) tail.push(line);
  return result;
}

function describe(outcome: Outcome, source: string): string {
  switch (outcome.kind) {
    case "matched": return `Matched in ${source}`;
    case "prompt": return `The shell in ${source} is back at its prompt${outcome.status !== undefined ? ` (last command exit status ${outcome.status})` : ""}`;
    case "exited": return `${source} exited${outcome.status !== undefined ? ` with status ${outcome.status}` : ""}`;
    case "timeout": return `Timed out waiting for ${source}`;
  }
}

function idleAtPrompt(log: string, end: number, input: number | undefined): PromptMark | undefined {
  const last = lastPromptMark(log, end);
  if (!last || last.kind === "C") return undefined;
  return input === undefined || last.end > input ? last : undefined;
}

export default function waitExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wait",
    label: "Wait",
    description: "Wait until a panel, log file, or process is ready instead of sleeping. Returns at the first of: a line matching `match` (JavaScript regex) in new output; a panel's shell returning to its prompt; the panel's or pid's process exiting; or timeoutSeconds. "
      + "For a panel, new output is everything since the last panel-send or previous wait on it, so output printed just before the call is not missed. "
      + "A command typed into an interactive shell in a panel (including over ssh) is detected as finished only when that shell reports its prompt with OSC 133 marks; panel-send warns when its input goes somewhere without them. "
      + `${SHELL_INTEGRATION_HINT} For a file, only text appended after the call counts and \`match\` is required.`,
    promptSnippet: "Wait for panel output, shell prompts, process exit, or log lines, instead of sleep",
    promptGuidelines: ["Never run sleep to wait for builds, servers, or panels; use wait so you continue as soon as the result is ready."],
    parameters: Type.Object({
      panel: Type.Optional(Type.String({ description: "Registered panel name." })),
      file: Type.Optional(Type.String({ description: "Log file to follow." })),
      pid: Type.Optional(Type.Integer({ minimum: 1, description: "Process to wait for." })),
      match: Type.Optional(Type.String({ minLength: 1, description: "JavaScript regular expression tested against each new output line." })),
      timeoutSeconds: Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: "Upper bound, not an expected duration." }),
    }),
    renderCall: (args) => renderToolCall("wait", args),
    async execute(_id, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const sources = [params.panel, params.file, params.pid].filter((value) => value !== undefined);
      if (sources.length !== 1) throw new Error("Supply exactly one of panel, file, or pid.");
      const regex = compile(params.match);
      const startedAt = Date.now();
      const deadline = startedAt + params.timeoutSeconds * 1000;
      const tail = new Tail();
      let target: HostTarget | undefined;
      let log: string;
      let source: string;
      let offset: number;
      let promptAfter: number | undefined;
      let outcome: Outcome | undefined;

      if (params.pid !== undefined) {
        if (regex) throw new Error("match is not supported with pid; wait for a panel or file instead.");
        source = `pid ${params.pid}`;
        const alive = () => {
          try { process.kill(params.pid!, 0); return true; }
          catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
        };
        while (alive() && Date.now() < deadline) await delay(POLL_MS, undefined, { signal });
        outcome = alive() ? { kind: "timeout" } : { kind: "exited" };
        log = "";
        offset = 0;
      } else if (params.file !== undefined) {
        if (!regex) throw new Error("A file wait needs match: a file has no prompt or exit to wait for.");
        log = path.resolve(ctx.cwd, params.file.replace(/^~(?=\/|$)/, os.homedir()));
        if (!fs.existsSync(log)) throw new Error(`File does not exist: ${log}. If a panel or process creates it, wait on that panel (output, prompt, or exit) or pid instead.`);
        source = log;
        offset = fileSize(log);
      } else {
        const name = validateName(params.panel!);
        target = readTarget(name);
        if (!target) throw new Error(`No panel named '${name}'. Use /panels to list panels.`);
        if (target.kind !== "shell" || !target.outputPath) throw new Error(`'${name}' has no captured output to wait on${target.kind === "shell" ? "; it was started before output capture existed. Close and restart it." : ": it is not a shell panel."}`);
        log = target.outputPath;
        source = `panel ${name}`;
        const host = hostForTarget(pi, target);
        const state = await host.state(target, signal);
        if (state === "missing") throw new Error(`Panel '${name}' no longer exists on ${target.host}. Close it and start a new one.`);
        const cursor = readCursor(log);
        const size = fileSize(log);
        offset = cursor.cursor <= size ? cursor.cursor : 0;
        const idle = idleAtPrompt(log, size, cursor.input);
        if (state !== "running") outcome = { kind: "exited", status: capturedExitStatus(log) };
        else if (idle) outcome = { kind: "prompt", ...(idle.status !== undefined ? { status: idle.status } : {}) };
        else promptAfter = size;
      }

      let lastState = Date.now();
      let lastProgress = Date.now();
      while (!outcome) {
        const result = scan(log, offset, regex, promptAfter, tail);
        offset = result.next;
        if (result.found) { outcome = result.found.outcome; break; }
        if (result.exitStatus !== undefined) { outcome = { kind: "exited", status: result.exitStatus }; break; }
        if (result.more) continue;
        if (target && Date.now() - lastState >= STATE_POLL_MS) {
          lastState = Date.now();
          const state = await hostForTarget(pi, target).state(target, signal);
          if (state === "missing") throw new Error(`Panel '${target.name}' no longer exists on ${target.host}.`);
          if (state === "exited") {
            const final = scan(log, offset, regex, promptAfter, tail);
            offset = final.next;
            outcome = final.found?.outcome ?? { kind: "exited", status: final.exitStatus };
            break;
          }
        }
        if (Date.now() >= deadline) { outcome = { kind: "timeout" }; break; }
        if (Date.now() - lastProgress >= PROGRESS_MS) {
          lastProgress = Date.now();
          onUpdate?.({
            content: [{ type: "text", text: `Waiting ${duration(Date.now() - startedAt)} for ${source}${tail.lines.length ? `; last line: ${tail.lines.at(-1)}` : ""}` }],
            details: { source, elapsedMs: Date.now() - startedAt } satisfies WaitDetails,
          });
        }
        await delay(POLL_MS, undefined, { signal });
      }

      if (target) writeCursor(log, { ...readCursor(log), cursor: offset });
      const elapsedMs = Date.now() - startedAt;
      let output = tail.text();
      if (target) {
        try { output = truncateTail(await hostForTarget(pi, target).read(target, TAIL_LINES, signal), { maxLines: TAIL_LINES, maxBytes: 8192 }).content || output; }
        catch { signal?.throwIfAborted(); /* The examined log tail remains a faithful fallback. */ }
      }
      const lines = [`${describe(outcome, source)} after ${duration(elapsedMs)}.`];
      if (outcome.kind === "matched") lines.push(`Matched line: ${outcome.line}`);
      if (outcome.kind === "timeout" && target && !regex) {
        const warning = promptWarning(promptReporting(log, fileSize(log), readCursor(log).input));
        if (warning) lines.push(warning);
      }
      if (params.pid === undefined) lines.push("", target ? `${source} screen:` : "New output:", output);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          source, outcome: outcome.kind, elapsedMs,
          ...("status" in outcome && outcome.status !== undefined ? { status: outcome.status } : {}),
          ...(outcome.kind === "matched" ? { line: outcome.line } : {}),
        } satisfies WaitDetails,
      };
    },
  });
}
