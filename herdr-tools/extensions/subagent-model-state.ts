import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_MODEL_STATE_CUSTOM_TYPE = "pi-herdr:subagent-model";
const SUBAGENT_MODEL_FAVORITE_PATH = path.join(os.homedir(), ".pi", "agent", "subagent-model-favorite.json");

export const SUBAGENT_MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SubagentModelThinkingLevel = (typeof SUBAGENT_MODEL_THINKING_LEVELS)[number];

export interface SubagentModelState {
  provider: string;
  modelId: string;
  thinkingLevel?: SubagentModelThinkingLevel;
  updatedAt: string;
}

export interface SubagentModelStoredState {
  provider?: string;
  modelId?: string;
  thinkingLevel?: SubagentModelThinkingLevel;
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

export function isSubagentModelThinkingLevel(value: string): value is SubagentModelThinkingLevel {
  return SUBAGENT_MODEL_THINKING_LEVELS.includes(value as SubagentModelThinkingLevel);
}

function getCustomStateEntries(ctx: ExtensionContext): CustomStateEntryLike[] {
  const entries: CustomStateEntryLike[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (!isRecord(entry) || typeof entry.type !== "string" || typeof entry.customType !== "string") continue;
    entries.push({ type: entry.type, customType: entry.customType, data: entry.data });
  }
  return entries;
}

function parseStoredState(value: unknown): SubagentModelStoredState | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.updatedAt !== "string") return undefined;

  if (value.cleared === true) {
    return { updatedAt: value.updatedAt, cleared: true };
  }

  if (typeof value.provider !== "string" || typeof value.modelId !== "string") return undefined;
  const thinkingLevel = typeof value.thinkingLevel === "string" && isSubagentModelThinkingLevel(value.thinkingLevel)
    ? value.thinkingLevel
    : undefined;

  return {
    provider: value.provider,
    modelId: value.modelId,
    thinkingLevel,
    updatedAt: value.updatedAt,
  };
}

function toSubagentModelState(state: SubagentModelStoredState): SubagentModelState | undefined {
  if (!state.provider || !state.modelId) return undefined;
  return {
    provider: state.provider,
    modelId: state.modelId,
    thinkingLevel: state.thinkingLevel,
    updatedAt: state.updatedAt,
  };
}

function getBranchSubagentModelState(ctx: ExtensionContext): SubagentModelState | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== SUBAGENT_MODEL_STATE_CUSTOM_TYPE) continue;
    const state = parseStoredState(entry.data);
    if (!state) continue;
    if (state.cleared) return undefined;
    const subagentModelState = toSubagentModelState(state);
    if (subagentModelState) return subagentModelState;
  }
  return undefined;
}

function getSavedFavoriteSubagentModelState(): SubagentModelState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(SUBAGENT_MODEL_FAVORITE_PATH, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const state = parseStoredState(parsed);
    return state && !state.cleared ? toSubagentModelState(state) : undefined;
  } catch {
    return undefined;
  }
}

export function getSubagentModelState(ctx: ExtensionContext): SubagentModelState | undefined {
  return getBranchSubagentModelState(ctx);
}

export function getFavoriteSubagentModelState(_ctx: ExtensionContext): SubagentModelState | undefined {
  return getSavedFavoriteSubagentModelState();
}

export function saveFavoriteSubagentModelState(state: SubagentModelState): void {
  fs.mkdirSync(path.dirname(SUBAGENT_MODEL_FAVORITE_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${SUBAGENT_MODEL_FAVORITE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, SUBAGENT_MODEL_FAVORITE_PATH);
}

export function createSubagentModelState(model: Model<Api>, thinkingLevel?: SubagentModelThinkingLevel): SubagentModelState {
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel,
    updatedAt: new Date().toISOString(),
  };
}

export function createClearedSubagentModelState(): SubagentModelStoredState {
  return {
    cleared: true,
    updatedAt: new Date().toISOString(),
  };
}

export function subagentModelCliArgs(state: SubagentModelState | undefined): string[] {
  if (!state) return [];
  return [
    "--provider",
    state.provider,
    "--model",
    state.modelId,
    ...(state.thinkingLevel ? ["--thinking", state.thinkingLevel] : []),
  ];
}

export function getSubagentModelCliArgs(ctx: ExtensionContext): string[] {
  return subagentModelCliArgs(getSubagentModelState(ctx));
}

export function subagentModelPiArgsString(state: SubagentModelState | undefined): string | undefined {
  const args = subagentModelCliArgs(state);
  return args.length > 0 ? args.join(" ") : undefined;
}

export function getSubagentModelPiArgsString(ctx: ExtensionContext): string | undefined {
  return subagentModelPiArgsString(getSubagentModelState(ctx));
}

export function formatSubagentModel(state: SubagentModelState | undefined): string {
  if (!state) return "unset";
  return `${state.provider}/${state.modelId}${state.thinkingLevel ? `:${state.thinkingLevel}` : ""}`;
}
