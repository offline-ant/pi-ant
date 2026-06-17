import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createClearedToolModelState,
  createToolModelState,
  formatToolModel,
  getToolModelState,
  isToolModelThinkingLevel,
  TOOL_MODEL_STATE_CUSTOM_TYPE,
  type ToolModelState,
  type ToolModelThinkingLevel,
} from "./tool-model-state.ts";

interface ParsedToolModelCommand {
  action: "status" | "clear" | "current" | "set";
  provider?: string;
  modelPattern?: string;
  thinkingLevel?: ToolModelThinkingLevel;
}

interface ResolvedToolModel {
  model: Model<Api>;
  thinkingLevel?: ToolModelThinkingLevel;
}

function parseCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === '"') && quote === undefined) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (/\s/.test(char) && quote === undefined) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (quote !== undefined) throw new Error(`Unclosed ${quote} quote`);
  if (current.length > 0) tokens.push(current);

  return tokens;
}

function splitThinkingSuffix(value: string): { value: string; thinkingLevel?: ToolModelThinkingLevel } {
  const colonIndex = value.lastIndexOf(":");
  if (colonIndex === -1) return { value };

  const suffix = value.slice(colonIndex + 1);
  if (!isToolModelThinkingLevel(suffix)) return { value };
  return { value: value.slice(0, colonIndex), thinkingLevel: suffix };
}

function parseToolModelCommand(args: string | undefined): ParsedToolModelCommand {
  const tokens = parseCommandLine((args ?? "").trim());
  if (tokens.length === 0 || tokens[0] === "status") return { action: "status" };

  const first = tokens.shift();
  if (first === undefined) return { action: "status" };
  const action = first.toLowerCase();

  if (action === "off" || action === "clear" || action === "unset") {
    if (tokens.length > 0) throw new Error(`Unexpected argument after ${first}: ${tokens[0]}`);
    return { action: "clear" };
  }

  if (action === "current") {
    let thinkingLevel: ToolModelThinkingLevel | undefined;
    if (tokens.length > 1) throw new Error(`Unexpected extra argument: ${tokens[1]}`);
    if (tokens.length === 1) {
      if (!isToolModelThinkingLevel(tokens[0])) throw new Error(`Invalid thinking level: ${tokens[0]}`);
      thinkingLevel = tokens[0];
    }
    return { action: "current", thinkingLevel };
  }

  tokens.unshift(first);

  let thinkingLevel: ToolModelThinkingLevel | undefined;
  const last = tokens[tokens.length - 1];
  if (last && isToolModelThinkingLevel(last)) {
    thinkingLevel = last;
    tokens.pop();
  }

  if (tokens.length === 0) throw new Error("Usage: /tool-model <provider>/<model> [thinking]");

  if (tokens.length === 1) {
    const split = splitThinkingSuffix(tokens[0]);
    return {
      action: "set",
      modelPattern: split.value,
      thinkingLevel: thinkingLevel ?? split.thinkingLevel,
    };
  }

  if (tokens.length === 2) {
    const split = splitThinkingSuffix(tokens[1]);
    return {
      action: "set",
      provider: tokens[0],
      modelPattern: split.value,
      thinkingLevel: thinkingLevel ?? split.thinkingLevel,
    };
  }

  throw new Error(`Unexpected extra argument: ${tokens[2]}`);
}

function canonicalProviderMap(models: Model<Api>[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const model of models) {
    map.set(model.provider.toLowerCase(), model.provider);
  }
  return map;
}

function byExactModelReference(models: Model<Api>[], reference: string): Model<Api>[] {
  const normalized = reference.toLowerCase();
  return models.filter(
    (model) => model.id.toLowerCase() === normalized || `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
}

function byFuzzyModelReference(models: Model<Api>[], reference: string): Model<Api>[] {
  const normalized = reference.toLowerCase();
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(normalized) ||
      model.name?.toLowerCase().includes(normalized) ||
      `${model.provider}/${model.id}`.toLowerCase().includes(normalized),
  );
}

async function resolveToolModel(
  ctx: ExtensionContext,
  parsed: ParsedToolModelCommand,
  currentThinkingLevel: ToolModelThinkingLevel,
): Promise<ResolvedToolModel> {
  const availableModels = await ctx.modelRegistry.getAvailable();
  if (availableModels.length === 0) {
    throw new Error("No authenticated models are available.");
  }

  if (parsed.action === "current") {
    if (!ctx.model) throw new Error("No current model is selected.");
    const current = availableModels.find((model) => model.provider === ctx.model?.provider && model.id === ctx.model.id);
    if (!current) throw new Error(`Current model is not available: ${ctx.model.provider}/${ctx.model.id}`);
    return { model: current, thinkingLevel: parsed.thinkingLevel ?? currentThinkingLevel };
  }

  if (parsed.action !== "set" || !parsed.modelPattern) {
    throw new Error("No model was provided.");
  }

  let candidates = availableModels;
  let pattern = parsed.modelPattern;
  const providers = canonicalProviderMap(availableModels);
  let provider = parsed.provider ? providers.get(parsed.provider.toLowerCase()) : undefined;

  if (parsed.provider && !provider) {
    throw new Error(`Unknown or unauthenticated provider: ${parsed.provider}`);
  }

  if (!provider) {
    const slashIndex = pattern.indexOf("/");
    if (slashIndex !== -1) {
      const maybeProvider = pattern.slice(0, slashIndex);
      const canonical = providers.get(maybeProvider.toLowerCase());
      if (canonical) {
        provider = canonical;
        pattern = pattern.slice(slashIndex + 1);
      }
    }
  }

  if (provider) {
    candidates = availableModels.filter((model) => model.provider === provider);
  }

  let matches = byExactModelReference(candidates, pattern);
  if (matches.length === 0 && provider) {
    matches = candidates.filter((model) => model.id.toLowerCase() === pattern.toLowerCase());
  }
  if (matches.length === 0 && !provider) {
    matches = byExactModelReference(availableModels, parsed.modelPattern);
  }
  if (matches.length === 0) {
    matches = byFuzzyModelReference(candidates, pattern);
  }

  if (matches.length === 0) {
    throw new Error(`No authenticated model matches: ${parsed.provider ? `${parsed.provider}/` : ""}${parsed.modelPattern}`);
  }
  if (matches.length > 1) {
    const preview = matches.slice(0, 8).map((model) => `${model.provider}/${model.id}`).join(", ");
    const suffix = matches.length > 8 ? `, ... (${matches.length} total)` : "";
    throw new Error(`Model reference is ambiguous: ${parsed.modelPattern}. Matches: ${preview}${suffix}`);
  }

  return { model: matches[0], thinkingLevel: parsed.thinkingLevel };
}

function statusLine(state: ToolModelState | undefined): string {
  if (!state) return "tool-model: unset";
  return `tool-model: ${formatToolModel(state)}`;
}

function updateUi(ctx: ExtensionContext): void {
  const state = getToolModelState(ctx);
  ctx.ui.setStatus("tool-model", state ? ctx.ui.theme.fg("accent", `tool:${formatToolModel(state)}`) : undefined);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tool-model", {
    description:
      "Set the model used by tool-spawned workers. Usage: /tool-model [status|current|off|<provider>/<model> [thinking]]",
    getArgumentCompletions: (prefix) => {
      const actions = ["status", "current", "off", "clear", "unset"];
      const trimmed = prefix.trim().toLowerCase();
      const matches = actions
        .filter((action) => action.startsWith(trimmed))
        .map((action) => ({ value: action, label: action }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      let parsed: ParsedToolModelCommand;
      try {
        parsed = parseToolModelCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (parsed.action === "status") {
        ctx.ui.notify(statusLine(getToolModelState(ctx)), "info");
        updateUi(ctx);
        return;
      }

      if (parsed.action === "clear") {
        pi.appendEntry(TOOL_MODEL_STATE_CUSTOM_TYPE, createClearedToolModelState());
        updateUi(ctx);
        ctx.ui.notify("tool-model cleared; tool workers will use normal pi model selection.", "info");
        return;
      }

      try {
        const resolved = await resolveToolModel(ctx, parsed, pi.getThinkingLevel());
        const state = createToolModelState(resolved.model, resolved.thinkingLevel);
        pi.appendEntry(TOOL_MODEL_STATE_CUSTOM_TYPE, state);
        updateUi(ctx);
        ctx.ui.notify(`tool-model set: ${formatToolModel(state)}`, "info");
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
