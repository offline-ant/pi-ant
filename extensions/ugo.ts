import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReplacedSessionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  formatGuidanceResult,
  GUIDANCE_SYSTEM_PROMPT,
  PRESENT_GUIDANCE_PARAMS,
  type PresentGuidanceParams,
  validateGuidance,
} from "./guidance-core.ts";

const STATE_CUSTOM_TYPE = "pi-ant:ugo-state";
const RESULT_CUSTOM_TYPE = "pi-ant:ugo-guidance";
const MESSAGE_CUSTOM_TYPE = "pi-ant:ugo-message";
const PRESENT_GUIDANCE_TOOL = "present_guidance";
const WORKBOARD_FILE = "workboard.md";
const DECISIONS_DIR = join("scratch", "decisions");
const DEFAULT_MAX_ITERATIONS = 20;
const execFileAsync = promisify(execFile);

type UgoPhase = "guide" | "do" | "paused" | "stalled" | "disabled";
type UgoMode = "auto" | "manual";

interface UgoState {
  active: boolean;
  phase: UgoPhase;
  mode: UgoMode;
  iteration: number;
  maxIterations: number;
  originalTools: string[];
  previousGuidance?: PresentGuidanceParams;
  lastGuidance?: PresentGuidanceParams;
  doPrompt?: string;
  doCompleted?: boolean;
  reason?: string;
}

interface DecisionSignal {
  kind: "DONE" | "CLARIFY";
  path: string;
  line: string;
  content: string;
}

interface CustomStateEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
}

interface TextBlockLike {
  type: string;
  text?: unknown;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

interface MessageEntryLike {
  type?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGuidanceStatus(
  value: unknown,
): value is PresentGuidanceParams["status"] {
  return value === "CONTINUE" || value === "STALLED" || value === "DONE";
}

function isPresentGuidanceParams(
  value: unknown,
): value is PresentGuidanceParams {
  if (!isRecord(value)) return false;
  return (
    isGuidanceStatus(value.status) &&
    typeof value.item === "string" &&
    typeof value.reason === "string" &&
    (value.nextPrompt === undefined || typeof value.nextPrompt === "string") &&
    (value.workboardUpdate === undefined ||
      typeof value.workboardUpdate === "string")
  );
}

function normalizePhase(value: unknown): UgoPhase | undefined {
  if (
    value === "guide" ||
    value === "do" ||
    value === "paused" ||
    value === "stalled" ||
    value === "disabled"
  ) {
    return value;
  }
  return undefined;
}

function isUgoState(value: unknown): value is UgoState {
  if (!isRecord(value)) return false;
  return (
    typeof value.active === "boolean" &&
    normalizePhase(value.phase) !== undefined &&
    (value.mode === "auto" || value.mode === "manual") &&
    typeof value.iteration === "number" &&
    typeof value.maxIterations === "number" &&
    Array.isArray(value.originalTools) &&
    value.originalTools.every((tool) => typeof tool === "string")
  );
}

function getCustomStateEntries(ctx: ExtensionContext): CustomStateEntryLike[] {
  return ctx.sessionManager
    .getBranch()
    .filter((entry): entry is CustomStateEntryLike => {
      if (!isRecord(entry)) return false;
      return (
        typeof entry.type === "string" && typeof entry.customType === "string"
      );
    });
}

function getStateFromDetails(details: unknown): UgoState | undefined {
  if (!isRecord(details)) return undefined;
  return isUgoState(details.state) ? details.state : undefined;
}

function getLatestState(ctx: ExtensionContext): UgoState | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType === STATE_CUSTOM_TYPE && isUgoState(entry.data))
      return entry.data;
    if (entry.customType === MESSAGE_CUSTOM_TYPE) {
      const state = getStateFromDetails(entry.details);
      if (state) return state;
    }
  }
  return undefined;
}

function getLatestGuidance(
  ctx: ExtensionContext,
): PresentGuidanceParams | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry.customType === RESULT_CUSTOM_TYPE &&
      isPresentGuidanceParams(entry.data)
    )
      return entry.data;
  }
  return undefined;
}

function withoutPresentGuidance(tools: string[]): string[] {
  return tools.filter((tool) => tool !== PRESENT_GUIDANCE_TOOL);
}

function uniqueTools(tools: string[]): string[] {
  return [...new Set(tools)];
}

function persistState(sessionManager: SessionManager, state: UgoState): void {
  sessionManager.appendCustomEntry(STATE_CUSTOM_TYPE, state);
}

function appendUgoMessage(
  sessionManager: SessionManager,
  content: string,
  details: unknown,
): void {
  sessionManager.appendCustomMessageEntry(
    MESSAGE_CUSTOM_TYPE,
    content,
    true,
    details,
  );
}

function guidePrompt(state: UgoState): string {
  const previous = state.previousGuidance
    ? `\n\nPrevious guidance result for context:\n${formatGuidanceResult(state.previousGuidance)}`
    : "";
  return `Investigate the lowest runnable item in workboard.md and call present_guidance with the result.${previous}`;
}

function workboardUpdatePrompt(update: string): string {
  return [
    "Apply this workboard.md update only.",
    "Do not change source code or authority docs.",
    "Edit workboard.md so it reflects the requested state change.",
    "If workboard.md does not exist, report that and stop.",
    "Before finishing, say exactly what changed in workboard.md.",
    "",
    "Requested update:",
    update,
  ].join("\n");
}

function decisionSignalPrompt(
  signal: DecisionSignal,
  guidance: PresentGuidanceParams | undefined,
): string {
  const target = guidance
    ? `Guidance item: ${guidance.item}\nGuidance reason: ${guidance.reason}`
    : "Guidance item: infer the matching needs-decision item from workboard.md and the signal file.";

  const action =
    signal.kind === "DONE"
      ? [
          "The human resolved the decision. Update workboard.md so the matching item is runnable.",
          "Move the item from needs-decision to ready unless the DONE text explicitly names a different runnable section.",
          "Include the chosen decision in the moved item so the next worker does not need to reopen the decision thread.",
        ]
      : [
          "The human requested clarification. Update workboard.md so the matching item moves to needs-enrichment.",
          "Include the CLARIFY request as the next enrichment question/context target.",
          "Do not make a protocol or design choice on the human's behalf.",
        ];

  return [
    "Apply this human decision signal only.",
    "Do not change source code or authority docs.",
    "Read workboard.md and the signal file, then update workboard.md to reflect the signal.",
    "Keep the decision artifact if it is useful, but remove or mark the DONE/CLARIFY sentinel as consumed so it does not trigger again.",
    "Before finishing, say exactly which files changed.",
    "",
    target,
    "",
    `Signal file: ${signal.path}`,
    `Signal: ${signal.line}`,
    "",
    ...action,
    "",
    "Signal file content:",
    signal.content,
  ].join("\n");
}

function formatGuidanceSummary(
  guidance: PresentGuidanceParams,
  prompt: string | undefined,
): string {
  const lines = [
    `Guidance result: ${guidance.status}`,
    `Item: ${guidance.item}`,
    `Reason: ${guidance.reason}`,
  ];
  if (guidance.artifact) lines.push(`Artifact: ${guidance.artifact}`);
  if (guidance.notes) lines.push(`Notes: ${guidance.notes}`);
  if (prompt) lines.push("", "Do prompt:", prompt);
  if (guidance.choices && guidance.choices.length > 0) {
    lines.push("", "Choices:");
    for (const choice of guidance.choices) {
      lines.push(
        `- ${choice.recommended ? "[recommended] " : ""}${choice.label}${choice.description ? ` — ${choice.description}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function formatSessionMessage(state: UgoState): string {
  if (state.phase === "guide")
    return `Ugo: guide phase #${state.iteration} (${state.mode}).`;
  if (state.phase === "do" && state.previousGuidance)
    return formatGuidanceSummary(state.previousGuidance, state.doPrompt);
  return `Ugo: ${state.phase}${state.reason ? ` — ${state.reason}` : ""}.`;
}

function hasReplacementMessageMethods(
  ctx: ExtensionContext | ReplacedSessionContext,
): ctx is ReplacedSessionContext {
  return "sendMessage" in ctx;
}

async function recordState(
  ctx: ExtensionContext | ReplacedSessionContext,
  state: UgoState,
): Promise<void> {
  if (!hasReplacementMessageMethods(ctx)) return;
  await ctx.sendMessage({
    customType: MESSAGE_CUSTOM_TYPE,
    content: formatSessionMessage(state),
    display: true,
    details: { state },
  });
}

function promptPreview(prompt: string): string {
  return `${prompt.slice(0, 120)}${prompt.length > 120 ? "…" : ""}`;
}

function updateUi(ctx: ExtensionContext, state: UgoState | undefined): void {
  if (!state?.active) {
    ctx.ui.setStatus("ugo", undefined);
    ctx.ui.setWidget("ugo", undefined);
    return;
  }

  ctx.ui.setStatus(
    "ugo",
    ctx.ui.theme.fg("accent", `ugo:${state.phase}#${state.iteration}`),
  );

  const widget = [
    `ugo: ${state.phase} phase #${state.iteration} (${state.mode})`,
  ];
  if (state.phase === "guide") {
    if (state.previousGuidance)
      widget.push(
        `previous guidance: ${state.previousGuidance.status} — ${state.previousGuidance.item}`,
      );
    widget.push("current: choosing next workboard step");
  } else if (state.phase === "do") {
    if (state.previousGuidance)
      widget.push(
        `guidance: ${state.previousGuidance.status} — ${state.previousGuidance.item}`,
      );
    if (state.doPrompt) {
      const label =
        state.mode === "manual" && !state.doCompleted
          ? "do prompt ready"
          : "current do prompt";
      widget.push(`${label}: ${promptPreview(state.doPrompt)}`);
    }
  } else {
    if (state.lastGuidance)
      widget.push(
        `guidance: ${state.lastGuidance.status} — ${state.lastGuidance.item}`,
      );
    if (state.doPrompt)
      widget.push(`do prompt: ${promptPreview(state.doPrompt)}`);
  }
  if (state.reason) widget.push(`reason: ${state.reason}`);
  ctx.ui.setWidget("ugo", widget);
}

function parseStartArgs(args: string): {
  mode: UgoMode;
  maxIterations: number;
} {
  const parts = args
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const mode: UgoMode = parts.includes("auto") ? "auto" : "manual";
  const maxPart = parts.find((part) => part.startsWith("max="));
  const parsedMax = maxPart
    ? Number.parseInt(maxPart.slice("max=".length), 10)
    : DEFAULT_MAX_ITERATIONS;
  return {
    mode,
    maxIterations:
      Number.isFinite(parsedMax) && parsedMax > 0
        ? parsedMax
        : DEFAULT_MAX_ITERATIONS,
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (!isRecord(block)) return "";
      const textBlock = block as TextBlockLike;
      return textBlock.type === "text" && typeof textBlock.text === "string"
        ? textBlock.text
        : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function textFromMessage(message: unknown, role: "assistant" | "user"): string {
  if (!isRecord(message)) return "";
  const candidate = message as MessageLike;
  if (candidate.role !== role) return "";
  return textFromContent(candidate.content);
}

function lastMessageTextFromContext(
  ctx: ExtensionContext,
  role: "assistant" | "user",
): string {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as MessageEntryLike;
    if (entry.type !== "message") continue;
    const text = textFromMessage(entry.message, role);
    if (text.trim().length > 0) return text;
  }
  return "";
}

function lastAssistantTextFromContext(ctx: ExtensionContext): string {
  return lastMessageTextFromContext(ctx, "assistant");
}

function lastUserTextFromContext(ctx: ExtensionContext): string {
  return lastMessageTextFromContext(ctx, "user");
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function gitStatus(cwd: string): Promise<string> {
  const result = await runGit(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  return result.stdout.trim();
}

function commitSubject(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "ugo: checkpoint";
  const subject = `ugo: ${normalized}`;
  return subject.length <= 72
    ? subject
    : `${subject.slice(0, 69).trimEnd()}...`;
}

function guidanceDetails(guidance: PresentGuidanceParams | undefined): string {
  if (!guidance) return "(none)";
  return [
    `Status: ${guidance.status}`,
    `Item: ${guidance.item}`,
    `Reason: ${guidance.reason}`,
    guidance.artifact ? `Artifact: ${guidance.artifact}` : undefined,
    guidance.notes ? `Notes: ${guidance.notes}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function commitMessage(params: {
  phase: "guide" | "do";
  prompt: string;
  response: string;
  state: UgoState;
  guidance?: PresentGuidanceParams;
  sessionFile?: string;
}): string {
  const item =
    params.guidance?.item ??
    params.state.previousGuidance?.item ??
    params.state.lastGuidance?.item ??
    params.state.phase;
  return [
    commitSubject(item),
    "",
    `Ugo phase: ${params.phase}`,
    `Ugo iteration: ${params.state.iteration}`,
    `Ugo mode: ${params.state.mode}`,
    params.sessionFile ? `Session: ${params.sessionFile}` : undefined,
    "",
    "Guidance:",
    guidanceDetails(
      params.guidance ??
        params.state.previousGuidance ??
        params.state.lastGuidance,
    ),
    "",
    "Prompt:",
    params.prompt.trim() || "(empty)",
    "",
    "Agent result:",
    params.response.trim() || "(no assistant text captured)",
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function commitIfNeeded(params: {
  cwd: string;
  phase: "guide" | "do";
  prompt: string;
  response: string;
  state: UgoState;
  guidance?: PresentGuidanceParams;
  sessionFile?: string;
}): Promise<boolean> {
  if ((await gitStatus(params.cwd)).length === 0) return false;

  await runGit(params.cwd, ["add", "-A"]);
  if ((await gitStatus(params.cwd)).length === 0) return false;

  const tempDir = await mkdtemp(join(tmpdir(), "pi-ugo-commit-"));
  const messagePath = join(tempDir, "message.txt");
  try {
    await writeFile(messagePath, commitMessage(params), "utf8");
    await runGit(params.cwd, ["commit", "-F", messagePath]);
    return true;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function hasWorkboard(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, WORKBOARD_FILE));
    return true;
  } catch {
    return false;
  }
}

function findDecisionSignal(
  path: string,
  content: string,
): DecisionSignal | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*(DONE|CLARIFY)(?::\s*(.*))?\s*$/i.exec(line);
    if (!match) continue;
    const kind = match[1]?.toUpperCase();
    if (kind !== "DONE" && kind !== "CLARIFY") continue;
    return { kind, path, line: line.trim(), content };
  }
  return undefined;
}

async function readDecisionSignal(
  cwd: string,
  path: string,
): Promise<DecisionSignal | undefined> {
  try {
    return findDecisionSignal(path, await readFile(join(cwd, path), "utf8"));
  } catch {
    return undefined;
  }
}

async function decisionSignalPaths(cwd: string): Promise<string[]> {
  const paths = [WORKBOARD_FILE];
  try {
    const entries = await readdir(join(cwd, DECISIONS_DIR), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isFile()) paths.push(join(DECISIONS_DIR, entry.name));
    }
  } catch {
    // No decision directory yet.
  }
  return paths;
}

async function scanDecisionSignals(
  cwd: string,
): Promise<DecisionSignal | undefined> {
  for (const path of await decisionSignalPaths(cwd)) {
    const signal = await readDecisionSignal(cwd, path);
    if (signal) return signal;
  }
  return undefined;
}

function statusPath(line: string): string {
  const rawPath = line.slice(3);
  const renameIndex = rawPath.indexOf(" -> ");
  return renameIndex >= 0
    ? rawPath.slice(renameIndex + " -> ".length)
    : rawPath;
}

function isWatchedDecisionPath(path: string): boolean {
  return path === WORKBOARD_FILE || path.startsWith(`${DECISIONS_DIR}/`);
}

function statusOnlyTouchesDecisionFiles(status: string): boolean {
  if (!status.trim()) return true;
  return status
    .split(/\r?\n/)
    .every((line) => isWatchedDecisionPath(statusPath(line)));
}

export default function (pi: ExtensionAPI) {
  let currentState: UgoState | undefined;
  let presentGuidanceRegistered = false;
  let decisionWatchers: FSWatcher[] = [];
  let decisionWatchTimer: ReturnType<typeof setTimeout> | undefined;
  let decisionWatcherBusy = false;
  let decisionWatcherBlocked = false;

  function registerPresentGuidanceTool(): void {
    if (presentGuidanceRegistered) return;
    presentGuidanceRegistered = true;
    pi.registerTool({
      name: PRESENT_GUIDANCE_TOOL,
      label: "Present Guidance",
      description:
        "Validate and store a workboard guidance decision. Use only as the final action while selecting the next workboard step.",
      promptSnippet:
        "Emit a validated workboard guidance decision as the final action",
      promptGuidelines: [
        "Use present_guidance exactly once as the final action while selecting the next workboard step.",
      ],
      parameters: PRESENT_GUIDANCE_PARAMS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const errors = validateGuidance(params);
        if (errors.length > 0) {
          throw new Error(
            `Invalid guidance output:\n${errors.map((error) => `- ${error}`).join("\n")}`,
          );
        }

        pi.appendEntry(RESULT_CUSTOM_TYPE, params);
        if (currentState) {
          currentState = { ...currentState, lastGuidance: params };
          pi.appendEntry(STATE_CUSTOM_TYPE, currentState);
          updateUi(ctx, currentState);
        }

        return {
          content: [{ type: "text", text: formatGuidanceResult(params) }],
          details: params,
          terminate: true,
        };
      },
    });
  }

  function activateToolsForState(state: UgoState | undefined): void {
    if (state?.active && state.phase === "guide") {
      registerPresentGuidanceTool();
      pi.setActiveTools(
        uniqueTools([
          ...withoutPresentGuidance(state.originalTools),
          PRESENT_GUIDANCE_TOOL,
        ]),
      );
      return;
    }

    const active = pi.getActiveTools();
    const restored =
      state?.originalTools && state.originalTools.length > 0
        ? state.originalTools
        : active;
    pi.setActiveTools(withoutPresentGuidance(restored));
  }

  function appendCurrentState(state: UgoState): void {
    currentState = state;
    pi.appendEntry(STATE_CUSTOM_TYPE, state);
  }

  async function persistCurrentState(
    ctx: ExtensionContext | ReplacedSessionContext,
    state: UgoState,
  ): Promise<void> {
    currentState = state;
    if (hasReplacementMessageMethods(ctx)) {
      await recordState(ctx, state);
      return;
    }
    pi.appendEntry(STATE_CUSTOM_TYPE, state);
  }

  async function commitStepOrPause(
    ctx: ExtensionContext | ReplacedSessionContext,
    params: {
      phase: "guide" | "do";
      prompt: string;
      response: string;
      state: UgoState;
      guidance?: PresentGuidanceParams;
    },
  ): Promise<boolean> {
    try {
      const committed = await commitIfNeeded({
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        ...params,
      });
      if (committed)
        ctx.ui.notify(`Ugo committed ${params.phase} phase.`, "info");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pausedState: UgoState = {
        ...params.state,
        phase: "paused",
        reason: `git commit failed after ${params.phase}: ${message}`,
      };
      await persistCurrentState(ctx, pausedState);
      updateUi(ctx, pausedState);
      ctx.ui.notify(
        `Ugo paused: git commit failed after ${params.phase}. ${message}`,
        "error",
      );
      return false;
    }
  }

  function closeDecisionWatchers(): void {
    for (const watcher of decisionWatchers) watcher.close();
    decisionWatchers = [];
    if (decisionWatchTimer) clearTimeout(decisionWatchTimer);
    decisionWatchTimer = undefined;
    decisionWatcherBusy = false;
    decisionWatcherBlocked = false;
  }

  async function runDecisionSignalSession(
    ctx: ExtensionCommandContext | ReplacedSessionContext,
    state: UgoState,
    signal: DecisionSignal,
  ): Promise<void> {
    closeDecisionWatchers();
    const prompt = decisionSignalPrompt(signal, state.lastGuidance);
    const doState: UgoState = {
      ...state,
      phase: "do",
      previousGuidance: state.lastGuidance,
      doPrompt: prompt,
      doCompleted: false,
      reason: `human ${signal.kind} signal in ${signal.path}`,
    };
    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await ctx.newSession({
      parentSession,
      setup: async (sessionManager) => {
        persistState(sessionManager, doState);
        appendUgoMessage(sessionManager, formatSessionMessage(doState), {
          state: doState,
        });
      },
      withSession: async (signalCtx) => {
        updateUi(signalCtx, doState);
        await signalCtx.sendUserMessage(prompt);
        const latestState = getLatestState(signalCtx);
        if (latestState && !latestState.active) {
          updateUi(signalCtx, latestState);
          signalCtx.ui.notify(
            "Ugo is disabled; not committing or continuing.",
            "info",
          );
          return;
        }
        const activeState = latestState?.active ? latestState : doState;
        const committed = await commitStepOrPause(signalCtx, {
          phase: "do",
          prompt,
          response: lastAssistantTextFromContext(signalCtx),
          state: activeState,
          guidance: activeState.previousGuidance,
        });
        if (!committed) return;
        await runGuideSession(signalCtx, {
          ...activeState,
          phase: "guide",
          doPrompt: undefined,
          doCompleted: true,
        });
      },
    });

    if (result.cancelled)
      ctx.ui.notify("Ugo decision signal session was cancelled.", "warning");
  }

  function scheduleDecisionSignalScan(
    ctx: ExtensionCommandContext | ReplacedSessionContext,
    state: UgoState,
  ): void {
    if (decisionWatchTimer) clearTimeout(decisionWatchTimer);
    decisionWatchTimer = setTimeout(() => {
      decisionWatchTimer = undefined;
      void (async () => {
        if (decisionWatcherBusy) return;
        decisionWatcherBusy = true;
        try {
          const latestState = getLatestState(ctx) ?? currentState ?? state;
          if (!latestState.active || latestState.phase !== "stalled") return;
          const signal = await scanDecisionSignals(ctx.cwd);
          if (!signal) return;
          const status = await gitStatus(ctx.cwd);
          if (!statusOnlyTouchesDecisionFiles(status)) {
            if (!decisionWatcherBlocked) {
              decisionWatcherBlocked = true;
              ctx.ui.notify(
                "Ugo saw a DONE/CLARIFY signal but unrelated files are dirty. Clean or commit them, then save the signal file again or run /ugo-continue.",
                "warning",
              );
            }
            return;
          }
          await runDecisionSignalSession(ctx, latestState, signal);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Ugo decision watcher failed: ${message}`, "error");
        } finally {
          decisionWatcherBusy = false;
        }
      })();
    }, 250);
  }

  async function startDecisionWatcher(
    ctx: ExtensionCommandContext | ReplacedSessionContext,
    state: UgoState,
  ): Promise<void> {
    closeDecisionWatchers();
    const watchPaths = [WORKBOARD_FILE, DECISIONS_DIR];
    for (const path of watchPaths) {
      try {
        await access(join(ctx.cwd, path));
        decisionWatchers.push(
          watch(join(ctx.cwd, path), () =>
            scheduleDecisionSignalScan(ctx, state),
          ),
        );
      } catch {
        // Missing watched paths are fine; guidance may not have produced a decision artifact.
      }
    }
    ctx.ui.notify(
      "Ugo is watching workboard.md and scratch/decisions for DONE:/CLARIFY:.",
      "info",
    );
    scheduleDecisionSignalScan(ctx, state);
  }

  async function startDoSession(
    ctx: ExtensionCommandContext | ReplacedSessionContext,
    state: UgoState,
  ): Promise<void> {
    closeDecisionWatchers();
    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await ctx.newSession({
      parentSession,
      setup: async (sessionManager) => {
        persistState(sessionManager, state);
        appendUgoMessage(sessionManager, formatSessionMessage(state), {
          state,
        });
      },
      withSession: async (doCtx) => {
        updateUi(doCtx, state);
        if (!state.doPrompt) {
          doCtx.ui.notify("Ugo do phase has no do prompt.", "error");
          return;
        }

        if (state.mode === "manual") {
          doCtx.ui.setEditorText(state.doPrompt);
          doCtx.ui.notify(
            "Ugo prepared the do prompt. Edit or submit it, then run /ugo-continue after the turn finishes.",
            "info",
          );
          return;
        }

        await doCtx.sendUserMessage(state.doPrompt);
        const latestState = getLatestState(doCtx);
        if (latestState && !latestState.active) {
          updateUi(doCtx, latestState);
          doCtx.ui.notify(
            "Ugo is disabled; not committing or continuing.",
            "info",
          );
          return;
        }
        const activeState = latestState?.active ? latestState : state;
        const committed = await commitStepOrPause(doCtx, {
          phase: "do",
          prompt: state.doPrompt,
          response: lastAssistantTextFromContext(doCtx),
          state: activeState,
          guidance: activeState.previousGuidance,
        });
        if (!committed) return;
        const afterCommitState = getLatestState(doCtx);
        if (afterCommitState && !afterCommitState.active) {
          updateUi(doCtx, afterCommitState);
          doCtx.ui.notify("Ugo is disabled; not continuing.", "info");
          return;
        }
        await runGuideSession(doCtx, {
          ...activeState,
          phase: "guide",
          doPrompt: undefined,
          doCompleted: true,
        });
      },
    });

    if (result.cancelled)
      ctx.ui.notify("Ugo do session was cancelled.", "warning");
  }

  async function continueAfterGuidance(
    ctx: ExtensionCommandContext | ReplacedSessionContext,
    state: UgoState,
    guidance: PresentGuidanceParams,
  ): Promise<void> {
    if (guidance.status === "STALLED") {
      const stalledState: UgoState = {
        ...state,
        active: true,
        phase: "stalled",
        lastGuidance: guidance,
        reason: guidance.reason,
      };
      await persistCurrentState(ctx, stalledState);
      updateUi(ctx, stalledState);
      ctx.ui.notify(`Ugo stalled: ${guidance.reason}`, "warning");
      await startDecisionWatcher(ctx, stalledState);
      return;
    }

    const doPrompt =
      guidance.status === "DONE"
        ? workboardUpdatePrompt(guidance.workboardUpdate ?? "")
        : guidance.nextPrompt;

    if (!doPrompt?.trim()) {
      const pausedState: UgoState = {
        ...state,
        active: true,
        phase: "paused",
        lastGuidance: guidance,
        reason: "guidance did not include an executable prompt",
      };
      await persistCurrentState(ctx, pausedState);
      updateUi(ctx, pausedState);
      ctx.ui.notify(
        "Ugo paused: guidance did not include a prompt.",
        "warning",
      );
      return;
    }

    const doState: UgoState = {
      ...state,
      phase: "do",
      previousGuidance: guidance,
      lastGuidance: guidance,
      doPrompt,
      doCompleted: false,
      reason: undefined,
    };
    await startDoSession(ctx, doState);
  }

  async function runGuideSession(
    ctx: ExtensionCommandContext | ReplacedSessionContext,
    state: UgoState,
  ): Promise<void> {
    closeDecisionWatchers();
    if (state.iteration >= state.maxIterations) {
      const pausedState: UgoState = {
        ...state,
        active: true,
        phase: "paused",
        reason: `reached max=${state.maxIterations}`,
      };
      await persistCurrentState(ctx, pausedState);
      updateUi(ctx, pausedState);
      ctx.ui.notify(
        `Ugo paused after ${state.maxIterations} guide iterations.`,
        "warning",
      );
      return;
    }

    const guideState: UgoState = {
      ...state,
      active: true,
      phase: "guide",
      iteration: state.iteration + 1,
      doPrompt: undefined,
      lastGuidance: undefined,
      reason: undefined,
    };
    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await ctx.newSession({
      parentSession,
      setup: async (sessionManager) => {
        persistState(sessionManager, guideState);
        appendUgoMessage(sessionManager, formatSessionMessage(guideState), {
          state: guideState,
        });
      },
      withSession: async (guideCtx) => {
        updateUi(guideCtx, guideState);
        const prompt = guidePrompt(guideState);
        await guideCtx.sendUserMessage(prompt);
        const guidance = getLatestGuidance(guideCtx);
        if (!guidance) {
          const pausedState: UgoState = {
            ...guideState,
            phase: "paused",
            reason: "present_guidance was not called",
          };
          await persistCurrentState(guideCtx, pausedState);
          updateUi(guideCtx, pausedState);
          guideCtx.ui.notify(
            "Ugo paused: present_guidance was not called.",
            "warning",
          );
          return;
        }
        const committed = await commitStepOrPause(guideCtx, {
          phase: "guide",
          prompt,
          response: formatGuidanceResult(guidance),
          state: { ...guideState, lastGuidance: guidance },
          guidance,
        });
        if (!committed) return;
        await continueAfterGuidance(guideCtx, guideState, guidance);
      },
    });

    if (result.cancelled)
      ctx.ui.notify("Ugo guide session was cancelled.", "warning");
  }

  pi.registerCommand("ugo", {
    description: "Run ugo: /ugo [auto|manual] [max=N]",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const parsed = parseStartArgs(args);
      if (!(await hasWorkboard(ctx.cwd))) {
        ctx.ui.notify(
          "Ugo needs workboard.md. Run /new-workboard first or create workboard.md.",
          "warning",
        );
        return;
      }
      let status: string;
      try {
        status = await gitStatus(ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Ugo requires a git repository: ${message}`, "error");
        return;
      }
      if (status.length > 0) {
        ctx.ui.notify(
          "Ugo requires a clean worktree before starting because it commits after each phase.",
          "error",
        );
        return;
      }
      const initialState: UgoState = {
        active: true,
        phase: "guide",
        mode: parsed.mode,
        iteration: 0,
        maxIterations: parsed.maxIterations,
        originalTools: withoutPresentGuidance(pi.getActiveTools()),
      };
      ctx.ui.notify(`Starting ugo in ${parsed.mode} mode.`, "info");
      await runGuideSession(ctx, initialState);
    },
  });

  pi.registerCommand("ugo-continue", {
    description: "Continue ugo after a manual do phase",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const state = getLatestState(ctx);
      if (!state?.active) {
        ctx.ui.notify("No active ugo session here.", "warning");
        return;
      }

      if (state.phase === "guide") {
        const guidance = getLatestGuidance(ctx);
        if (!guidance) {
          ctx.ui.notify(
            "Ugo guide phase has no present_guidance result yet.",
            "warning",
          );
          return;
        }
        await continueAfterGuidance(ctx, state, guidance);
        return;
      }

      if (
        state.phase === "do" ||
        state.phase === "paused" ||
        state.phase === "stalled"
      ) {
        await runGuideSession(ctx, {
          ...state,
          phase: "guide",
          doPrompt: undefined,
          doCompleted: true,
        });
        return;
      }

      ctx.ui.notify(
        `Ugo is ${state.phase}; not continuing automatically.`,
        "warning",
      );
    },
  });

  pi.registerCommand("ugo-disable", {
    description: "Disable ugo without aborting the current agent turn",
    handler: async (_args, ctx) => {
      const state = getLatestState(ctx) ?? currentState;
      if (!state?.active) {
        ctx.ui.notify("No active ugo session to disable.", "info");
        return;
      }
      closeDecisionWatchers();
      const disabledState: UgoState = {
        ...state,
        active: false,
        phase: "disabled",
        reason: "disabled by user",
      };
      appendCurrentState(disabledState);
      activateToolsForState(disabledState);
      updateUi(ctx, disabledState);
      ctx.ui.notify(
        "Ugo disabled. The current agent turn is not aborted.",
        "info",
      );
    },
  });

  pi.registerCommand("ugo-status", {
    description: "Show ugo status",
    handler: async (_args, ctx) => {
      const state = getLatestState(ctx) ?? currentState;
      if (!state) {
        ctx.ui.notify("No ugo state in this session.", "info");
        return;
      }
      ctx.ui.notify(formatSessionMessage(state), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentState = getLatestState(ctx);
    if (!currentState?.active || currentState.phase !== "stalled")
      closeDecisionWatchers();
    activateToolsForState(currentState);
    if (currentState?.active)
      pi.setSessionName(`ugo ${currentState.phase} #${currentState.iteration}`);
    updateUi(ctx, currentState);
  });

  pi.on("before_agent_start", async (event) => {
    if (currentState?.active && currentState.phase === "guide") {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE_SYSTEM_PROMPT}`,
      };
    }
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getLatestState(ctx) ?? currentState;
    if (!state?.active || state.mode !== "manual") return;

    if (state.phase === "do") {
      const completedState: UgoState = { ...state, doCompleted: true };
      if (state.doPrompt) {
        const committed = await commitStepOrPause(ctx, {
          phase: "do",
          prompt: lastUserTextFromContext(ctx) || state.doPrompt,
          response: lastAssistantTextFromContext(ctx),
          state: completedState,
          guidance: state.previousGuidance,
        });
        if (!committed) return;
      }
      appendCurrentState(completedState);
      updateUi(ctx, completedState);
      ctx.ui.setEditorText("/ugo-continue");
      ctx.ui.notify(
        "Ugo do phase finished. Submit /ugo-continue to start the next guide phase.",
        "info",
      );
    }
  });
}
