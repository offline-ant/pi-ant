import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TOOL_MODEL_STATE_CUSTOM_TYPE = "pi-ant:tool-model";

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

export function getToolModelState(ctx: ExtensionContext): ToolModelState | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== TOOL_MODEL_STATE_CUSTOM_TYPE) continue;
    const state = parseStoredState(entry.data);
    if (!state) continue;
    if (state.cleared) return undefined;
    if (state.provider && state.modelId) {
      return {
        provider: state.provider,
        modelId: state.modelId,
        thinkingLevel: state.thinkingLevel,
        updatedAt: state.updatedAt,
      };
    }
  }
  return undefined;
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
