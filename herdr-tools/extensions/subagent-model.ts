import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createClearedSubagentModelState,
  createSubagentModelState,
  formatSubagentModel,
  getFavoriteSubagentModelState,
  getSubagentModelState,
  saveFavoriteSubagentModelState,
  SUBAGENT_MODEL_STATE_CUSTOM_TYPE,
  type SubagentModelState,
  type SubagentModelThinkingLevel,
} from "./subagent-model-state.ts";

type SubagentModelCommandAction = "toggle" | "status" | "clear";

function parseSubagentModelCommand(args: string | undefined): SubagentModelCommandAction {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (trimmed.length === 0) return "toggle";
  if (trimmed === "status") return "status";
  if (trimmed === "off" || trimmed === "clear" || trimmed === "unset") return "clear";
  throw new Error("Usage: /subagent-model [status|off]");
}

function parseSetSubagentModelCommand(args: string | undefined): "set" | "status" {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (trimmed.length === 0) return "set";
  if (trimmed === "status") return "status";
  throw new Error("Usage: /set-subagent-model [status]");
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

async function resolveStoredModel(ctx: ExtensionContext, state: SubagentModelState): Promise<Model<Api>> {
  const availableModels = await getAvailableModels(ctx);
  const model = availableModels.find((candidate) => candidate.provider === state.provider && candidate.id === state.modelId);
  if (!model) throw new Error(`Favorite subagent-model is not available: ${formatSubagentModel(state)}`);
  return model;
}

function statusLine(ctx: ExtensionContext): string {
  const state = getSubagentModelState(ctx);
  const favorite = getFavoriteSubagentModelState(ctx);
  if (!state && !favorite) return "subagent-model: unset; favorite: unset";
  if (!state) return `subagent-model: unset; favorite: ${formatSubagentModel(favorite)}`;
  return `subagent-model: ${formatSubagentModel(state)}; favorite: ${formatSubagentModel(favorite ?? state)}`;
}

function updateUi(ctx: ExtensionContext): void {
  const state = getSubagentModelState(ctx);
  ctx.ui.setStatus("subagent-model", state ? ctx.ui.theme.fg("accent", `subagent:${formatSubagentModel(state)}`) : undefined);
}

function appendSubagentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  model: Model<Api>,
  thinkingLevel?: SubagentModelThinkingLevel,
  verb = "set",
  notify = true,
): SubagentModelState {
  const state = createSubagentModelState(model, thinkingLevel);
  pi.appendEntry(SUBAGENT_MODEL_STATE_CUSTOM_TYPE, state);
  updateUi(ctx);
  if (notify) ctx.ui.notify(`subagent-model ${verb}: ${formatSubagentModel(state)}`, "info");
  return state;
}

function clearSubagentModel(pi: ExtensionAPI, ctx: ExtensionContext): void {
  pi.appendEntry(SUBAGENT_MODEL_STATE_CUSTOM_TYPE, createClearedSubagentModelState());
  updateUi(ctx);
  const favorite = getFavoriteSubagentModelState(ctx);
  const suffix = favorite ? ` /subagent-model restores favorite ${formatSubagentModel(favorite)}.` : " Use /set-subagent-model to choose a favorite.";
  ctx.ui.notify(`subagent-model cleared; spawned subagents will use normal pi model selection.${suffix}`, "info");
}

function saveFavoriteSubagentModel(ctx: ExtensionContext, state: SubagentModelState): void {
  try {
    saveFavoriteSubagentModelState(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`subagent-model favorite was not saved: ${message}`, "warning");
  }
}

async function enableFavoriteSubagentModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const favorite = getFavoriteSubagentModelState(ctx);
  if (!favorite) {
    const model = await resolveCurrentModel(ctx);
    const state = appendSubagentModel(pi, ctx, model, pi.getThinkingLevel(), "favorite set", false);
    saveFavoriteSubagentModel(ctx, state);
    ctx.ui.notify(`No favorite subagent-model. Setting ${formatSubagentModel(state)} as favorite; change favorite with /set-subagent-model.`, "warning");
    return;
  }

  const model = await resolveStoredModel(ctx, favorite);
  appendSubagentModel(pi, ctx, model, favorite.thinkingLevel, "enabled");
}

async function setFavoriteSubagentModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const model = await resolveCurrentModel(ctx);
  const state = appendSubagentModel(pi, ctx, model, pi.getThinkingLevel(), "favorite set");
  saveFavoriteSubagentModel(ctx, state);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("subagent-model", {
    description: "Toggle the favorite model override used by spawned subagents. Usage: /subagent-model [status|off]",
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

      let action: SubagentModelCommandAction;
      try {
        action = parseSubagentModelCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (action === "status") {
        ctx.ui.notify(statusLine(ctx), "info");
        updateUi(ctx);
        return;
      }

      if (action === "clear" || getSubagentModelState(ctx)) {
        clearSubagentModel(pi, ctx);
        return;
      }

      try {
        await enableFavoriteSubagentModel(pi, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("set-subagent-model", {
    description: "Set the current model as the favorite subagent override and enable it. Usage: /set-subagent-model [status]",
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
        action = parseSetSubagentModelCommand(args);
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
        await setFavoriteSubagentModel(pi, ctx);
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
