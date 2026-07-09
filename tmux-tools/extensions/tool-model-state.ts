import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TOOL_MODEL_STATE_CUSTOM_TYPE = "pi-tmux:tool-model";
const TOOL_MODEL_FAVORITE_PATH = path.join(os.homedir(), ".pi", "agent", "tool-model-favorite.json");

export const TOOL_MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ToolModelThinkingLevel = (typeof TOOL_MODEL_THINKING_LEVELS)[number];

export interface ToolModelState {
  provider: string;
  modelId: string;
  thinkingLevel?: ToolModelThinkingLevel;
  updatedAt: string;
}

export interface ToolModelStoredState {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ToolModelThinkingLevel;
  updatedAt: string;
  cleared?: boolean;
}

interface CustomStateEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isToolModelThinkingLevel(value: string): value is ToolModelThinkingLevel {
  return TOOL_MODEL_THINKING_LEVELS.includes(value as ToolModelThinkingLevel);
}

function getCustomStateEntries(ctx: ExtensionContext): CustomStateEntryLike[] {
  const entries: CustomStateEntryLike[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.customType !== "string") continue;
    entries.push({ type: entry.type, customType: entry.customType, data: entry.data });
  }
  return entries;
}

function parseStoredState(value: unknown): ToolModelStoredState | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.updatedAt !== "string") return undefined;

  if (value.cleared === true) {
    return { updatedAt: value.updatedAt, cleared: true };
  }

  if (typeof value.provider !== "string" || typeof value.modelId !== "string") return undefined;
  const thinkingLevel = typeof value.thinkingLevel === "string" && isToolModelThinkingLevel(value.thinkingLevel)
    ? value.thinkingLevel
    : undefined;

  return {
    provider: value.provider,
    modelId: value.modelId,
    thinkingLevel,
    updatedAt: value.updatedAt,
  };
}

function toToolModelState(state: ToolModelStoredState): ToolModelState | undefined {
  if (!state.provider || !state.modelId) return undefined;
  return {
    provider: state.provider,
    modelId: state.modelId,
    thinkingLevel: state.thinkingLevel,
    updatedAt: state.updatedAt,
  };
}

function getBranchToolModelState(ctx: ExtensionContext): ToolModelState | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== TOOL_MODEL_STATE_CUSTOM_TYPE) continue;
    const state = parseStoredState(entry.data);
    if (!state) continue;
    if (state.cleared) return undefined;
    const toolModelState = toToolModelState(state);
    if (toolModelState) return toolModelState;
  }
  return undefined;
}

function getSavedFavoriteToolModelState(): ToolModelState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(TOOL_MODEL_FAVORITE_PATH, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const state = parseStoredState(parsed);
    return state && !state.cleared ? toToolModelState(state) : undefined;
  } catch {
    return undefined;
  }
}

export function getToolModelState(ctx: ExtensionContext): ToolModelState | undefined {
  return getBranchToolModelState(ctx);
}

export function getFavoriteToolModelState(_ctx: ExtensionContext): ToolModelState | undefined {
  return getSavedFavoriteToolModelState();
}

export function saveFavoriteToolModelState(state: ToolModelState): void {
  fs.mkdirSync(path.dirname(TOOL_MODEL_FAVORITE_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${TOOL_MODEL_FAVORITE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, TOOL_MODEL_FAVORITE_PATH);
}

export function createToolModelState(model: Model<Api>, thinkingLevel?: ToolModelThinkingLevel): ToolModelState {
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel,
    updatedAt: new Date().toISOString(),
  };
}

export function createClearedToolModelState(): ToolModelStoredState {
  return {
    cleared: true,
    updatedAt: new Date().toISOString(),
  };
}

export function toolModelCliArgs(state: ToolModelState | undefined): string[] {
  if (!state) return [];
  return [
    "--provider",
    state.provider,
    "--model",
    state.modelId,
    ...(state.thinkingLevel ? ["--thinking", state.thinkingLevel] : []),
  ];
}

export function getToolModelCliArgs(ctx: ExtensionContext): string[] {
  return toolModelCliArgs(getToolModelState(ctx));
}

export function toolModelPiArgsString(state: ToolModelState | undefined): string | undefined {
  const args = toolModelCliArgs(state);
  return args.length > 0 ? args.join(" ") : undefined;
}

export function getToolModelPiArgsString(ctx: ExtensionContext): string | undefined {
  return toolModelPiArgsString(getToolModelState(ctx));
}

export function formatToolModel(state: ToolModelState | undefined): string {
  if (!state) return "unset";
  return `${state.provider}/${state.modelId}${state.thinkingLevel ? `:${state.thinkingLevel}` : ""}`;
}
