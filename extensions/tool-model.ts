import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createClearedToolModelState,
  createToolModelState,
  formatToolModel,
  getFavoriteToolModelState,
  getToolModelState,
  saveFavoriteToolModelState,
  TOOL_MODEL_STATE_CUSTOM_TYPE,
  type ToolModelState,
  type ToolModelThinkingLevel,
} from "./tool-model-state.ts";

type ToolModelCommandAction = "toggle" | "status" | "clear";

function parseToolModelCommand(args: string | undefined): ToolModelCommandAction {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (trimmed.length === 0) return "toggle";
  if (trimmed === "status") return "status";
  if (trimmed === "off" || trimmed === "clear" || trimmed === "unset") return "clear";
  throw new Error("Usage: /tool-model [status|off]");
}

function parseSetToolModelCommand(args: string | undefined): "set" | "status" {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (trimmed.length === 0) return "set";
  if (trimmed === "status") return "status";
  throw new Error("Usage: /set-tool-model [status]");
}

async function getAvailableModels(ctx: ExtensionContext): Promise<Model<Api>[]> {
  const availableModels = await ctx.modelRegistry.getAvailable();
  if (availableModels.length === 0) {
    throw new Error("No authenticated models are available.");
  }
  return availableModels;
}

async function resolveCurrentModel(ctx: ExtensionContext): Promise<Model<Api>> {
  if (!ctx.model) throw new Error("No current model is selected.");
  const availableModels = await getAvailableModels(ctx);
  const current = availableModels.find((model) => model.provider === ctx.model?.provider && model.id === ctx.model.id);
  if (!current) throw new Error(`Current model is not available: ${ctx.model.provider}/${ctx.model.id}`);
  return current;
}

async function resolveStoredModel(ctx: ExtensionContext, state: ToolModelState): Promise<Model<Api>> {
  const availableModels = await getAvailableModels(ctx);
  const model = availableModels.find((candidate) => candidate.provider === state.provider && candidate.id === state.modelId);
  if (!model) throw new Error(`Favorite tool-model is not available: ${formatToolModel(state)}`);
  return model;
}

function statusLine(ctx: ExtensionContext): string {
  const state = getToolModelState(ctx);
  const favorite = getFavoriteToolModelState(ctx);
  if (!state && !favorite) return "tool-model: unset; favorite: unset";
  if (!state) return `tool-model: unset; favorite: ${formatToolModel(favorite)}`;
  return `tool-model: ${formatToolModel(state)}; favorite: ${formatToolModel(favorite ?? state)}`;
}

function updateUi(ctx: ExtensionContext): void {
  const state = getToolModelState(ctx);
  ctx.ui.setStatus("tool-model", state ? ctx.ui.theme.fg("accent", `tool:${formatToolModel(state)}`) : undefined);
}

function appendToolModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  model: Model<Api>,
  thinkingLevel?: ToolModelThinkingLevel,
  verb = "set",
  notify = true,
): ToolModelState {
  const state = createToolModelState(model, thinkingLevel);
  pi.appendEntry(TOOL_MODEL_STATE_CUSTOM_TYPE, state);
  updateUi(ctx);
  if (notify) ctx.ui.notify(`tool-model ${verb}: ${formatToolModel(state)}`, "info");
  return state;
}

function clearToolModel(pi: ExtensionAPI, ctx: ExtensionContext): void {
  pi.appendEntry(TOOL_MODEL_STATE_CUSTOM_TYPE, createClearedToolModelState());
  updateUi(ctx);
  const favorite = getFavoriteToolModelState(ctx);
  const suffix = favorite ? ` /tool-model restores favorite ${formatToolModel(favorite)}.` : " Use /set-tool-model to choose a favorite.";
  ctx.ui.notify(`tool-model cleared; tool workers will use normal pi model selection.${suffix}`, "info");
}

function saveFavoriteToolModel(ctx: ExtensionContext, state: ToolModelState): void {
  try {
    saveFavoriteToolModelState(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`tool-model favorite was not saved: ${message}`, "warning");
  }
}

async function enableFavoriteToolModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const favorite = getFavoriteToolModelState(ctx);
  if (!favorite) {
    const model = await resolveCurrentModel(ctx);
    const state = appendToolModel(pi, ctx, model, pi.getThinkingLevel(), "favorite set", false);
    saveFavoriteToolModel(ctx, state);
    ctx.ui.notify(`No favorite tool-model. Setting ${formatToolModel(state)} as favorite; change favorite with /set-tool-model.`, "warning");
    return;
  }

  const model = await resolveStoredModel(ctx, favorite);
  appendToolModel(pi, ctx, model, favorite.thinkingLevel, "enabled");
}

async function setFavoriteToolModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const model = await resolveCurrentModel(ctx);
  const state = appendToolModel(pi, ctx, model, pi.getThinkingLevel(), "favorite set");
  saveFavoriteToolModel(ctx, state);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tool-model", {
    description: "Toggle the favorite model override used by tool-spawned workers. Usage: /tool-model [status|off]",
    getArgumentCompletions: (prefix) => {
      const actions = ["status", "off", "clear", "unset"];
      const trimmed = prefix.trim().toLowerCase();
      const matches = actions
        .filter((action) => action.startsWith(trimmed))
        .map((action) => ({ value: action, label: action }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      let action: ToolModelCommandAction;
      try {
        action = parseToolModelCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (action === "status") {
        ctx.ui.notify(statusLine(ctx), "info");
        updateUi(ctx);
        return;
      }

      if (action === "clear" || getToolModelState(ctx)) {
        clearToolModel(pi, ctx);
        return;
      }

      try {
        await enableFavoriteToolModel(pi, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("set-tool-model", {
    description: "Set the current model as the favorite tool-worker override and enable it. Usage: /set-tool-model [status]",
    getArgumentCompletions: (prefix) => {
      const actions = ["status"];
      const trimmed = prefix.trim().toLowerCase();
      const matches = actions
        .filter((action) => action.startsWith(trimmed))
        .map((action) => ({ value: action, label: action }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      let action: "set" | "status";
      try {
        action = parseSetToolModelCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (action === "status") {
        ctx.ui.notify(statusLine(ctx), "info");
        updateUi(ctx);
        return;
      }

      try {
        await setFavoriteToolModel(pi, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    updateUi(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    updateUi(ctx);
  });
}
