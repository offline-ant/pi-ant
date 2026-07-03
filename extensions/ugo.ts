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
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  formatGuidanceResult,
  PRESENT_GUIDANCE_PARAMS,
  type PresentGuidanceParams,
  validateGuidance,
} from "./guidance-core.ts";
import {
  ensureAndReadWorkflowFile,
  ensureWorkflowFile,
  formatGuidanceSystemPrompt,
  WORKFLOW_FILE,
} from "./workflow-core.ts";

const STATE_CUSTOM_TYPE = "pi-ant:ugo-state";
const RESULT_CUSTOM_TYPE = "pi-ant:ugo-guidance";
const MESSAGE_CUSTOM_TYPE = "pi-ant:ugo-message";
const PRESENT_GUIDANCE_TOOL = "present_guidance";
const WORKBOARD_FILE = "workboard.md";
const DECISIONS_DIR = join("scratch", "decisions");
const UGO_RETROSPECTIVE_PROMPT = [
  "The ugo-do main result has already been saved. Do not repeat it, do not continue the task, and do not call tools.",
  "Take a step back before ugo continues, then return exactly two bullet lines with these labels:",
  "- Retrospective: wrong-shape direction, missed design choice, or process/plan issue. Ask what should not exist, what mechanisms duplicate the same boundary, what state or authority boundary is in the wrong owner, and whether a cleaner cut would collapse the problem.",
  "- Simplify: concrete cleanup or simplification opportunities observed while doing the work. Prefer removing mechanisms, merging duplicated boundaries, deleting stale code/docs, or renaming unclear concepts. Do not invent broad rewrites.",
].join("\n");
const execFileAsync = promisify(execFile);

type UgoPhase =
  | "guide"
  | "do"
  | "do_retrospective"
  | "paused"
  | "awaiting_decision"
  | "empty";

interface UgoState {
  active: boolean;
  phase: UgoPhase;
  iteration: number;
  originalTools: string[];
  previousGuidance?: PresentGuidanceParams;
  lastGuidance?: PresentGuidanceParams;
  doPrompt?: string;
  doCompleted?: boolean;
  doMainResponse?: string;
  previousReflection?: string;
  pauseRequested?: boolean;
  reason?: string;
}

interface DecisionSignal {
  kind: "DONE" | "CLARIFY";
  path: string;
  line: string;
  content: string;
}

type ReplacementSessionContext = ExtensionCommandContext & {
  sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => Promise<void>;
  sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => Promise<void>;
};

type CustomStateEntryLike =
  | Extract<SessionEntry, { type: "custom" }>
  | Extract<SessionEntry, { type: "custom_message" }>;

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
  return (
    value === "CONTINUE_WORK" ||
    value === "UPDATE_WORK" ||
    value === "REQUIRE_HUMAN_DECISION" ||
    value === "EMPTY_WORKBOARD"
  );
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
    value === "do_retrospective" ||
    value === "paused" ||
    value === "awaiting_decision" ||
    value === "empty"
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
    typeof value.iteration === "number" &&
    Array.isArray(value.originalTools) &&
    value.originalTools.every((tool) => typeof tool === "string")
  );
}

function getCustomStateEntries(ctx: ExtensionContext): CustomStateEntryLike[] {
  return ctx.sessionManager
    .getBranch()
    .filter(
      (entry): entry is CustomStateEntryLike =>
        entry.type === "custom" || entry.type === "custom_message",
    );
}

function getStateFromDetails(details: unknown): UgoState | undefined {
  if (!isRecord(details)) return undefined;
  return isUgoState(details.state) ? details.state : undefined;
}

function getLatestState(ctx: ExtensionContext): UgoState | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry.type === "custom" &&
      entry.customType === STATE_CUSTOM_TYPE &&
      isUgoState(entry.data)
    )
      return entry.data;
    if (entry.type === "custom_message" && entry.customType === MESSAGE_CUSTOM_TYPE) {
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
      entry.type === "custom" &&
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

function appendUgoReflection(result: string, reflection: string): string {
  return [result.trimEnd(), "", "---", "", "Reflection:", reflection.trim()].join("\n");
}

function guidePrompt(state: UgoState): string {
  const previousGuidance = state.previousGuidance
    ? `\n\nPrevious guidance result for context:\n${formatGuidanceResult(state.previousGuidance)}`
    : "";
  const previousReflection = state.previousReflection
    ? [
        "",
        "The previous ugo-do reflection was this:",
        state.previousReflection,
        "",
        "If it contains a relevant improvement, cleanup, simplification opportunity, or follow-up to apply, upgrade it into a new workboard.md item or precise workboard.md update according to workflow.md. Prefer needs-distill for cleanup/docs and ready for concrete code simplification. If it is not relevant now, ignore it.",
      ].join("\n")
    : "";
  return `Inspect workboard.md, follow workflow.md, choose the next workflow outcome, and call present_guidance with the result.${previousGuidance}${previousReflection}`;
}

function workboardUpdatePrompt(update: string): string {
  return [
    "Apply this workboard.md update only.",
    "Do not change source code, authority docs, or workflow.md.",
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
    "Do not change source code, authority docs, or workflow.md.",
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
  displayUgoLabels = false,
): string {
  const lines = [
    `${displayUgoLabels ? "ugo-guide result" : "Guidance result"}: ${guidance.status}`,
    `Item: ${guidance.item}`,
    `Reason: ${guidance.reason}`,
  ];
  if (guidance.artifact) lines.push(`Artifact: ${guidance.artifact}`);
  if (guidance.notes) lines.push(`Notes: ${guidance.notes}`);
  if (prompt) lines.push("", displayUgoLabels ? "ugo-do prompt:" : "Worker prompt:", prompt);
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
    return "Select the next runnable workboard.md item and present the guidance result.";
  if (state.phase === "do" && state.previousGuidance)
    return formatGuidanceSummary(state.previousGuidance, state.doPrompt);
  if (state.phase === "do_retrospective")
    return "Collecting the no-tools reflection for the completed ugo-do result.";
  return `Workboard state: ${state.phase}${state.reason ? ` — ${state.reason}` : ""}.`;
}

function formatDisplaySessionMessage(state: UgoState): string {
  const pause = state.pauseRequested ? " (pause requested)" : "";
  if (state.phase === "guide")
    return `ugo-guide phase #${state.iteration}${pause}.`;
  if (state.phase === "do" && state.previousGuidance)
    return `${formatGuidanceSummary(state.previousGuidance, state.doPrompt, true)}${pause}`;
  if (state.phase === "do_retrospective")
    return `ugo-do reflection phase #${state.iteration}${pause}.`;
  return `${stateActor(state)} ${state.phase}${pause}${state.reason ? ` — ${state.reason}` : ""}.`;
}

function hasReplacementMessageMethods(
  ctx: ExtensionContext | ReplacementSessionContext,
): ctx is ReplacementSessionContext {
  return "sendMessage" in ctx;
}

async function recordState(
  ctx: ExtensionContext | ReplacementSessionContext,
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

function phaseActor(phase: "guide" | "do"): "ugo-guide" | "ugo-do" {
  return phase === "guide" ? "ugo-guide" : "ugo-do";
}

function stateActor(state: UgoState): string {
  if (state.phase === "guide" || state.phase === "do")
    return phaseActor(state.phase);
  if (state.phase === "do_retrospective") return "ugo-do";
  if (state.phase === "awaiting_decision" || state.phase === "empty")
    return "ugo-guide";
  return "ugo";
}

function updateUi(ctx: ExtensionContext, state: UgoState | undefined): void {
  if (!state?.active) {
    ctx.ui.setStatus("ugo", undefined);
    ctx.ui.setWidget("ugo", undefined);
    return;
  }

  const actor = stateActor(state);
  ctx.ui.setStatus(
    "ugo",
    ctx.ui.theme.fg("accent", `${actor}:${state.phase}#${state.iteration}`),
  );

  const widget = [
    `${actor}: ${state.phase} phase #${state.iteration}${state.pauseRequested ? " (pause requested)" : ""}`,
  ];
  if (state.phase === "guide") {
    if (state.previousGuidance)
      widget.push(
        `previous ugo-guide result: ${state.previousGuidance.status} — ${state.previousGuidance.item}`,
      );
    widget.push("current: choosing next workboard step");
  } else if (state.phase === "do") {
    if (state.previousGuidance)
      widget.push(
        `ugo-guide result: ${state.previousGuidance.status} — ${state.previousGuidance.item}`,
      );
    if (state.doPrompt) {
      widget.push(`current ugo-do prompt: ${promptPreview(state.doPrompt)}`);
    }
  } else if (state.phase === "do_retrospective") {
    if (state.previousGuidance)
      widget.push(
        `ugo-guide result: ${state.previousGuidance.status} — ${state.previousGuidance.item}`,
      );
    widget.push("current: collecting ugo-do reflection");
  } else {
    if (state.lastGuidance)
      widget.push(
        `ugo-guide result: ${state.lastGuidance.status} — ${state.lastGuidance.item}`,
      );
    if (state.doPrompt)
      widget.push(`ugo-do prompt: ${promptPreview(state.doPrompt)}`);
  }
  if (state.reason) widget.push(`reason: ${state.reason}`);
  ctx.ui.setWidget("ugo", widget);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (!isRecord(block)) return "";
      return block.type === "text" && typeof block.text === "string"
        ? block.text
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

function latestAssistantMessage(
  messages: AgentEndEvent["messages"],
): Extract<AgentEndEvent["messages"][number], { role: "assistant" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
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
  return result.stdout.trimEnd();
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
  const actor = phaseActor(params.phase);
  return [
    commitSubject(item),
    "",
    `${actor} phase`,
    `ugo loop iteration: ${params.state.iteration}`,
    params.sessionFile ? `Session: ${params.sessionFile}` : undefined,
    "",
    "ugo-guide result:",
    guidanceDetails(
      params.guidance ??
        params.state.previousGuidance ??
        params.state.lastGuidance,
    ),
    "",
    `${actor} prompt:`,
    params.prompt.trim() || "(empty)",
    "",
    `${actor} result:`,
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

function isWorkflowStatePath(path: string): boolean {
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  return (
    normalized === WORKBOARD_FILE ||
    normalized === WORKFLOW_FILE ||
    normalized.startsWith("scratch/")
  );
}

function statusOnlyTouchesWorkflowState(status: string): boolean {
  if (!status.trim()) return true;
  return status
    .split(/\r?\n/)
    .every((line) => isWorkflowStatePath(statusPath(line)));
}

function isScratchDecisionPath(path: string): boolean {
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  return normalized.startsWith(`${DECISIONS_DIR}/`);
}

function statusTouchesDecisionArtifacts(status: string): boolean {
  if (!status.trim()) return false;
  return status
    .split(/\r?\n/)
    .some((line) => isScratchDecisionPath(statusPath(line)));
}

function isStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "This extension ctx is stale after session replacement or reload",
    )
  );
}

function notifyIfContextActive(
  ctx: ExtensionContext | ReplacementSessionContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  try {
    ctx.ui.notify(message, level);
  } catch (error) {
    if (!isStaleContextError(error)) throw error;
  }
}

export default function (pi: ExtensionAPI) {
  let currentState: UgoState | undefined;
  let presentGuidanceRegistered = false;
  let decisionWatchers: FSWatcher[] = [];
  let decisionWatchTimer: ReturnType<typeof setTimeout> | undefined;
  let decisionWatcherBusy = false;
  let decisionWatcherBlocked = false;
  let decisionWatcherGeneration = 0;

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

    if (state?.active && state.phase === "do_retrospective") {
      pi.setActiveTools([]);
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
    ctx: ExtensionContext | ReplacementSessionContext,
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
    ctx: ExtensionContext | ReplacementSessionContext,
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
        ctx.ui.notify(`${phaseActor(params.phase)} committed.`, "info");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pausedState: UgoState = {
        ...params.state,
        phase: "paused",
        reason: `git commit failed after ${params.phase === "guide" ? "guidance" : "worker"} step: ${message}`,
      };
      await persistCurrentState(ctx, pausedState);
      updateUi(ctx, pausedState);
      ctx.ui.notify(
        `ugo paused: git commit failed after ${phaseActor(params.phase)}. ${message}`,
        "error",
      );
      return false;
    }
  }

  function hasSessionControl(
    ctx: ExtensionContext | ReplacementSessionContext,
  ): ctx is ExtensionCommandContext | ReplacementSessionContext {
    return "newSession" in ctx;
  }

  function makeDoRetrospectiveState(
    state: UgoState,
    prompt: string,
    response: string,
  ): UgoState {
    return {
      ...state,
      active: true,
      phase: "do_retrospective",
      doPrompt: prompt,
      doMainResponse: response,
      doCompleted: false,
      reason: "collecting ugo-do reflection",
    };
  }

  async function prepareDoRetrospective(
    ctx: ExtensionContext | ReplacementSessionContext,
    state: UgoState,
    prompt: string,
    response: string,
  ): Promise<UgoState> {
    const retrospectiveState = makeDoRetrospectiveState(state, prompt, response);
    await persistCurrentState(ctx, retrospectiveState);
    updateUi(ctx, retrospectiveState);
    pi.setActiveTools([]);
    return retrospectiveState;
  }

  async function queueDoRetrospective(
    ctx: ExtensionContext | ReplacementSessionContext,
    state: UgoState,
    prompt: string,
    response: string,
  ): Promise<void> {
    await prepareDoRetrospective(ctx, state, prompt, response);
    pi.sendUserMessage(UGO_RETROSPECTIVE_PROMPT, { deliverAs: "followUp" });
  }

  async function continueAfterCompletedDoIfNeeded(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
  ): Promise<void> {
    const latestState = getLatestState(ctx);
    if (!latestState?.active) {
      if (latestState) updateUi(ctx, latestState);
      return;
    }
    if (
      latestState.phase === "do" &&
      latestState.doCompleted === true &&
      latestState.pauseRequested !== true
    ) {
      await runGuideSession(ctx, {
        ...latestState,
        phase: "guide",
        doPrompt: undefined,
        doCompleted: true,
        doMainResponse: undefined,
        pauseRequested: undefined,
      });
    }
  }

  async function finishDoRetrospective(
    ctx: ExtensionContext | ReplacementSessionContext,
    state: UgoState,
  ): Promise<void> {
    const reflection =
      lastAssistantTextFromContext(ctx) ||
      "reflection unavailable: assistant returned no reflection text.";
    const completedState: UgoState = {
      ...state,
      phase: "do",
      doCompleted: true,
      doMainResponse: undefined,
      previousReflection: reflection,
      reason: undefined,
    };
    activateToolsForState(completedState);
    const committed = await commitStepOrPause(ctx, {
      phase: "do",
      prompt: state.doPrompt ?? "",
      response: appendUgoReflection(state.doMainResponse ?? "", reflection),
      state: completedState,
      guidance: state.previousGuidance,
    });
    if (!committed) return;

    if (completedState.pauseRequested) {
      const pausedState: UgoState = {
        ...completedState,
        phase: "paused",
        doPrompt: undefined,
        doMainResponse: undefined,
        pauseRequested: undefined,
        reason: "paused by user after ugo-do",
      };
      await persistCurrentState(ctx, pausedState);
      updateUi(ctx, pausedState);
      ctx.ui.notify("ugo paused after completing ugo-do.", "info");
      return;
    }

    if (hasSessionControl(ctx)) {
      await runGuideSession(ctx, {
        ...completedState,
        phase: "guide",
        doPrompt: undefined,
        doCompleted: true,
        doMainResponse: undefined,
      });
      return;
    }
    appendCurrentState(completedState);
    updateUi(ctx, completedState);
  }

  function closeDecisionWatchers(): void {
    decisionWatcherGeneration++;
    for (const watcher of decisionWatchers) watcher.close();
    decisionWatchers = [];
    if (decisionWatchTimer) clearTimeout(decisionWatchTimer);
    decisionWatchTimer = undefined;
    decisionWatcherBusy = false;
    decisionWatcherBlocked = false;
  }

  async function runDecisionSignalSession(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
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
      pauseRequested: undefined,
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
        await continueAfterCompletedDoIfNeeded(signalCtx);
      },
    });

    if (result.cancelled)
      ctx.ui.notify("ugo-do decision signal session was cancelled.", "warning");
  }

  function scheduleDecisionSignalScan(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
    state: UgoState,
  ): void {
    if (decisionWatchTimer) clearTimeout(decisionWatchTimer);
    const generation = decisionWatcherGeneration;
    decisionWatchTimer = setTimeout(() => {
      decisionWatchTimer = undefined;
      void (async () => {
        if (generation !== decisionWatcherGeneration) return;
        if (decisionWatcherBusy) return;
        decisionWatcherBusy = true;
        try {
          const cwd = ctx.cwd;
          const latestState = getLatestState(ctx) ?? currentState ?? state;
          if (!latestState.active || latestState.phase !== "awaiting_decision")
            return;
          const signal = await scanDecisionSignals(cwd);
          if (generation !== decisionWatcherGeneration) return;
          if (!signal) return;
          const status = await gitStatus(cwd);
          if (generation !== decisionWatcherGeneration) return;
          if (!statusOnlyTouchesWorkflowState(status)) {
            if (!decisionWatcherBlocked) {
              decisionWatcherBlocked = true;
              notifyIfContextActive(
                ctx,
                "ugo-guide saw a DONE/CLARIFY signal but files outside workboard.md, workflow.md, or scratch/ are dirty. Clean or commit them, then save the signal file again or run /ugo.",
                "warning",
              );
            }
            return;
          }
          await runDecisionSignalSession(ctx, latestState, signal);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          notifyIfContextActive(
            ctx,
            `ugo-guide decision watcher failed: ${message}`,
            "error",
          );
        } finally {
          decisionWatcherBusy = false;
        }
      })();
    }, 250);
  }

  async function startDecisionWatcher(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
    state: UgoState,
  ): Promise<void> {
    closeDecisionWatchers();
    const cwd = ctx.cwd;
    const watchPaths = [WORKBOARD_FILE, DECISIONS_DIR];
    for (const path of watchPaths) {
      try {
        await access(join(cwd, path));
        decisionWatchers.push(
          watch(join(cwd, path), () => scheduleDecisionSignalScan(ctx, state)),
        );
      } catch {
        // Missing watched paths are fine; guidance may not have produced a decision artifact.
      }
    }
    notifyIfContextActive(
      ctx,
      "ugo-guide is watching workboard.md and scratch/decisions for DONE:/CLARIFY:.",
      "info",
    );
    scheduleDecisionSignalScan(ctx, state);
  }

  function scheduleEmptyWorkboardScan(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
    state: UgoState,
  ): void {
    if (decisionWatchTimer) clearTimeout(decisionWatchTimer);
    const generation = decisionWatcherGeneration;
    decisionWatchTimer = setTimeout(() => {
      decisionWatchTimer = undefined;
      void (async () => {
        if (generation !== decisionWatcherGeneration) return;
        if (decisionWatcherBusy) return;
        decisionWatcherBusy = true;
        try {
          const cwd = ctx.cwd;
          const latestState = getLatestState(ctx) ?? currentState ?? state;
          if (!latestState.active || latestState.phase !== "empty") return;
          const status = await gitStatus(cwd);
          if (generation !== decisionWatcherGeneration) return;
          if (!statusOnlyTouchesWorkflowState(status)) {
            if (!decisionWatcherBlocked) {
              decisionWatcherBlocked = true;
              notifyIfContextActive(
                ctx,
                "ugo-guide saw a workboard.md edit but files outside workboard.md, workflow.md, or scratch/ are dirty. Clean or commit them, then save workboard.md again or run /ugo.",
                "warning",
              );
            }
            return;
          }
          await runGuideSession(ctx, {
            ...latestState,
            phase: "guide",
            doPrompt: undefined,
            doCompleted: true,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          notifyIfContextActive(
            ctx,
            `ugo-guide empty-workboard watcher failed: ${message}`,
            "error",
          );
        } finally {
          decisionWatcherBusy = false;
        }
      })();
    }, 250);
  }

  async function startEmptyWorkboardWatcher(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
    state: UgoState,
  ): Promise<void> {
    closeDecisionWatchers();
    try {
      await access(join(ctx.cwd, WORKBOARD_FILE));
      decisionWatchers.push(
        watch(join(ctx.cwd, WORKBOARD_FILE), () =>
          scheduleEmptyWorkboardScan(ctx, state),
        ),
      );
    } catch {
      // If workboard.md does not exist, /ugo can retry after creation.
    }
    notifyIfContextActive(
      ctx,
      "ugo-guide found an empty workboard and is watching workboard.md for new work.",
      "info",
    );
  }

  async function startDoSession(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
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
          doCtx.ui.notify("ugo-do has no prompt.", "error");
          return;
        }

        await doCtx.sendUserMessage(state.doPrompt);
        await continueAfterCompletedDoIfNeeded(doCtx);
      },
    });

    if (result.cancelled)
      ctx.ui.notify("ugo-do session was cancelled.", "warning");
  }

  async function continueAfterGuidance(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
    state: UgoState,
    guidance: PresentGuidanceParams,
  ): Promise<void> {
    const consumedReflectionState: UgoState = {
      ...state,
      previousReflection: undefined,
    };

    if (guidance.status === "REQUIRE_HUMAN_DECISION") {
      const decisionState: UgoState = {
        ...consumedReflectionState,
        active: true,
        phase: "awaiting_decision",
        lastGuidance: guidance,
        reason: guidance.reason,
      };
      await persistCurrentState(ctx, decisionState);
      updateUi(ctx, decisionState);
      ctx.ui.notify(
        `ugo-guide awaiting human decision: ${guidance.reason}`,
        "warning",
      );
      await startDecisionWatcher(ctx, decisionState);
      return;
    }

    if (guidance.status === "EMPTY_WORKBOARD") {
      const emptyState: UgoState = {
        ...consumedReflectionState,
        active: true,
        phase: "empty",
        lastGuidance: guidance,
        reason: guidance.reason,
      };
      await persistCurrentState(ctx, emptyState);
      updateUi(ctx, emptyState);
      ctx.ui.notify(`ugo-guide empty workboard: ${guidance.reason}`, "info");
      await startEmptyWorkboardWatcher(ctx, emptyState);
      return;
    }

    const doPrompt =
      guidance.status === "UPDATE_WORK"
        ? workboardUpdatePrompt(guidance.workboardUpdate ?? "")
        : guidance.nextPrompt;

    if (!doPrompt?.trim()) {
      const pausedState: UgoState = {
        ...consumedReflectionState,
        active: true,
        phase: "paused",
        lastGuidance: guidance,
        reason: "guidance did not include an executable worker prompt",
      };
      await persistCurrentState(ctx, pausedState);
      updateUi(ctx, pausedState);
      ctx.ui.notify(
        "ugo-guide paused: guidance did not include a ugo-do prompt.",
        "warning",
      );
      return;
    }

    const doState: UgoState = {
      ...consumedReflectionState,
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
    ctx: ExtensionCommandContext | ReplacementSessionContext,
    state: UgoState,
  ): Promise<void> {
    closeDecisionWatchers();

    const guideState: UgoState = {
      ...state,
      active: true,
      phase: "guide",
      iteration: state.iteration + 1,
      doPrompt: undefined,
      lastGuidance: undefined,
      pauseRequested: undefined,
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
            "ugo-guide paused: present_guidance was not called.",
            "warning",
          );
          return;
        }
        const guideResultState = { ...guideState, lastGuidance: guidance };
        if (guidance.status === "REQUIRE_HUMAN_DECISION") {
          try {
            if (!guidance.artifact?.trim()) throw new Error("missing artifact");
            await access(join(guideCtx.cwd, guidance.artifact));
          } catch {
            const pausedState: UgoState = {
              ...guideResultState,
              phase: "paused",
              reason:
                "REQUIRE_HUMAN_DECISION did not create its scratch/decisions artifact",
            };
            await persistCurrentState(guideCtx, pausedState);
            updateUi(guideCtx, pausedState);
            guideCtx.ui.notify(
              "ugo-guide paused: REQUIRE_HUMAN_DECISION must create its scratch/decisions artifact.",
              "error",
            );
            return;
          }
        }
        if (
          guidance.status !== "REQUIRE_HUMAN_DECISION" &&
          statusTouchesDecisionArtifacts(await gitStatus(guideCtx.cwd))
        ) {
          const pausedState: UgoState = {
            ...guideResultState,
            phase: "paused",
            reason:
              "guidance wrote scratch/decisions artifacts without REQUIRE_HUMAN_DECISION",
          };
          await persistCurrentState(guideCtx, pausedState);
          updateUi(guideCtx, pausedState);
          guideCtx.ui.notify(
            "ugo-guide paused: scratch/decisions artifacts are only allowed for REQUIRE_HUMAN_DECISION.",
            "error",
          );
          return;
        }
        const committed = await commitStepOrPause(guideCtx, {
          phase: "guide",
          prompt,
          response: formatGuidanceResult(guidance),
          state: guideResultState,
          guidance,
        });
        if (!committed) return;
        const latestAfterGuide = getLatestState(guideCtx) ?? guideResultState;
        if (latestAfterGuide.pauseRequested) {
          const pausedState: UgoState = {
            ...guideResultState,
            phase: "paused",
            pauseRequested: undefined,
            reason: "paused by user after ugo-guide",
          };
          await persistCurrentState(guideCtx, pausedState);
          updateUi(guideCtx, pausedState);
          guideCtx.ui.notify("ugo paused after completing ugo-guide.", "info");
          return;
        }
        await continueAfterGuidance(guideCtx, guideState, guidance);
      },
    });

    if (result.cancelled)
      ctx.ui.notify("ugo-guide session was cancelled.", "warning");
  }

  async function ensureUgoCanRun(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
  ): Promise<boolean> {
    let status: string;
    try {
      status = await gitStatus(ctx.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`ugo requires a git repository: ${message}`, "error");
      return false;
    }
    if (!statusOnlyTouchesWorkflowState(status)) {
      ctx.ui.notify(
        "ugo requires a clean worktree before starting except for workboard.md, workflow.md, and scratch/ changes because ugo-guide/ugo-do commit after each phase.",
        "error",
      );
      return false;
    }
    try {
      if (await ensureWorkflowFile(ctx.cwd)) {
        ctx.ui.notify(
          `Created ${WORKFLOW_FILE}. Edit it to customize ugo guidance.`,
          "info",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `ugo could not create ${WORKFLOW_FILE}: ${message}`,
        "error",
      );
      return false;
    }
    status = await gitStatus(ctx.cwd);
    if (!statusOnlyTouchesWorkflowState(status)) {
      ctx.ui.notify(
        "ugo requires a clean worktree before starting except for workboard.md, workflow.md, and scratch/ changes because ugo-guide/ugo-do commit after each phase.",
        "error",
      );
      return false;
    }
    if (!(await hasWorkboard(ctx.cwd))) {
      ctx.ui.notify(
        "ugo-guide needs workboard.md. Run /new-workboard first or create workboard.md.",
        "warning",
      );
      return false;
    }
    return true;
  }

  pi.registerCommand("ugo", {
    description: "Start or resume the ugo automatic workboard loop",
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        ctx.ui.notify("Usage: /ugo", "warning");
        return;
      }
      await ctx.waitForIdle();
      if (!(await ensureUgoCanRun(ctx))) return;

      const state = getLatestState(ctx) ?? currentState;
      if (state?.active) {
        if (
          state.phase === "guide" ||
          state.phase === "do_retrospective" ||
          (state.phase === "do" && state.doCompleted !== true)
        ) {
          ctx.ui.notify(
            `ugo is already running: ${formatDisplaySessionMessage(state)}`,
            "info",
          );
          return;
        }

        ctx.ui.notify("Resuming ugo.", "info");
        await runGuideSession(ctx, {
          ...state,
          phase: "guide",
          doPrompt: undefined,
          doCompleted: true,
          doMainResponse: undefined,
          pauseRequested: undefined,
          reason: undefined,
        });
        return;
      }

      const initialState: UgoState = {
        active: true,
        phase: "guide",
        iteration: 0,
        originalTools: withoutPresentGuidance(pi.getActiveTools()),
      };
      ctx.ui.notify("Starting ugo.", "info");
      await runGuideSession(ctx, initialState);
    },
  });

  pi.registerCommand("ugo-pause", {
    description: "Pause ugo after the current safe checkpoint",
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        ctx.ui.notify("Usage: /ugo-pause", "warning");
        return;
      }
      const state = getLatestState(ctx) ?? currentState;
      if (!state?.active) {
        ctx.ui.notify("No active ugo session to pause.", "info");
        return;
      }
      closeDecisionWatchers();

      if (state.phase === "paused") {
        ctx.ui.notify("ugo is already paused. Run /ugo to resume.", "info");
        return;
      }

      if (
        state.phase === "awaiting_decision" ||
        state.phase === "empty" ||
        (state.phase === "do" && state.doCompleted === true)
      ) {
        const pausedState: UgoState = {
          ...state,
          phase: "paused",
          pauseRequested: undefined,
          reason: "paused by user",
        };
        appendCurrentState(pausedState);
        activateToolsForState(pausedState);
        updateUi(ctx, pausedState);
        ctx.ui.notify("ugo paused. Run /ugo to resume.", "info");
        return;
      }

      const pauseState: UgoState = {
        ...state,
        pauseRequested: true,
        reason: state.reason ?? "pause requested by user",
      };
      appendCurrentState(pauseState);
      updateUi(ctx, pauseState);
      ctx.ui.notify(
        "ugo pause requested. The current agent turn will finish and checkpoint before ugo stops.",
        "info",
      );
    },
  });

  pi.on("session_shutdown", async () => {
    closeDecisionWatchers();
  });

  pi.on("session_start", async (_event, ctx) => {
    currentState = getLatestState(ctx);
    if (
      !currentState?.active ||
      (currentState.phase !== "awaiting_decision" &&
        currentState.phase !== "empty")
    )
      closeDecisionWatchers();
    activateToolsForState(currentState);
    if (currentState?.active)
      pi.setSessionName(
        `${stateActor(currentState)} ${currentState.phase} #${currentState.iteration}`,
      );
    updateUi(ctx, currentState);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (currentState?.active && currentState.phase === "guide") {
      try {
        const workflow = await ensureAndReadWorkflowFile(ctx.cwd);
        if (workflow.created) {
          ctx.ui.notify(
            `Created ${WORKFLOW_FILE}. Edit it to customize ugo guidance.`,
            "info",
          );
        }
        return {
          systemPrompt: `${event.systemPrompt}\n\n${formatGuidanceSystemPrompt(workflow.content)}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `ugo-guide could not load ${WORKFLOW_FILE}: ${message}`,
          "error",
        );
      }
    }
    if (currentState?.active && currentState.phase === "do_retrospective") {
      return {
        systemPrompt: `${event.systemPrompt}\n\nYou are in the ugo-do reflection phase. The main ugo-do result is already saved. Do not call tools and do not continue the original task. Answer only the reflection prompt.`,
      };
    }
    return undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    const state = getLatestState(ctx) ?? currentState;
    if (!state?.active) return;
    const message = latestAssistantMessage(event.messages);
    if (!message || message.stopReason !== "stop") return;

    if (state.phase === "do_retrospective") {
      await finishDoRetrospective(ctx, state);
      return;
    }

    if (state.phase === "do" && state.doPrompt) {
      await queueDoRetrospective(
        ctx,
        state,
        lastUserTextFromContext(ctx) || state.doPrompt,
        lastAssistantTextFromContext(ctx),
      );
    }
  });
}
