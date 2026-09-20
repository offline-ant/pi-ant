import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelCliArgs } from "./context.ts";

export type DelegateModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
export type DelegateModelPair = readonly [DelegateModel, DelegateModel];

export function delegateModelLabel(model: DelegateModel): string {
  return `${model.provider}/${model.id}`;
}

function parseModel(value: unknown): DelegateModel {
  if (typeof value !== "string" || /\s/.test(value)) throw new Error("Models must be exact provider/model identifiers.");
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error("Models must be exact provider/model identifiers.");
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function parsePair(value: unknown): DelegateModelPair {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Choose exactly two distinct models.");
  const pair = [parseModel(value[0]), parseModel(value[1])] as const;
  if (delegateModelLabel(pair[0]) === delegateModelLabel(pair[1])) throw new Error("Choose exactly two distinct models.");
  return pair;
}

export function resolveDelegateModel(
  ctx: ExtensionContext,
  pair: DelegateModelPair | null,
  alt: boolean,
): NonNullable<ExtensionContext["model"]> {
  if (!ctx.model) throw new Error("Current session has no selected model.");
  if (!alt) return ctx.model;
  if (!pair) throw new Error("Alternate delegation is disabled. Configure a model pair with /delegate-alt.");
  const current = delegateModelLabel(ctx.model);
  const index = pair.findIndex((model) => delegateModelLabel(model) === current);
  if (index < 0) throw new Error(`Current model ${current} is outside the /delegate-alt pair. Select a member or configure a different pair.`);
  const other = pair[index === 0 ? 1 : 0];
  const model = ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === other.provider && candidate.id === other.id);
  if (!model) {
    throw new Error(`Alternate delegate model unavailable: ${delegateModelLabel(other)}. Check authentication or disable it with /delegate-alt off.`);
  }
  return model;
}

export interface DelegateAltController {
  /** Refresh global configuration, then snapshot the selected model before worker startup. */
  resolve(ctx: ExtensionContext, alt: boolean): NonNullable<ExtensionContext["model"]>;
}

/** No file is created until the human explicitly chooses a pair. */
export function createDelegateAltController(
  pi: ExtensionAPI,
  changed: (pair: DelegateModelPair | null) => void,
): DelegateAltController {
  const file = path.join(getAgentDir(), "delegate-alt.json");
  let pair: DelegateModelPair | null = null;
  let lastError: string | undefined;

  function refresh(ctx: ExtensionContext): void {
    let next: DelegateModelPair | null = null;
    let error: string | undefined;
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || typeof data !== "object" || !("models" in data)) throw new Error("Expected { models: [provider/model, provider/model] }.");
      next = parsePair(data.models);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        error = `Alternate delegation disabled: invalid configuration at ${file}: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
    if (JSON.stringify(pair) !== JSON.stringify(next)) {
      pair = next;
      changed(pair);
    }
    if (error && error !== lastError) ctx.ui.notify(error, "error");
    lastError = error;
  }

  function report(ctx: ExtensionContext): void {
    const text = lastError ?? (pair
      ? `Alternate delegation enabled: ${pair.map(delegateModelLabel).join(" ↔ ")}. do, delegate, and fresh_look default to the caller's model; alt: true selects the other. Saved globally in ${file}.`
      : "Alternate delegation disabled. do, delegate, and fresh_look have no alt parameter.");
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else pi.sendMessage({ customType: "pi-orchestration:delegate-alt-status", content: text, display: true });
  }

  function save(next: DelegateModelPair | null): void {
    if (!next) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ models: next.map(delegateModelLabel) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  pi.registerCommand("delegate-alt", {
    description: "Enable alternate-model delegation with a model pair, disable it with off, or show status (saved globally; disabled by default)",
    getArgumentCompletions(prefix) {
      return ["off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      refresh(ctx);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 1 && tokens[0] === "status") { report(ctx); return; }
      let next: DelegateModelPair | null;
      if (tokens.length === 1 && tokens[0] === "off") {
        next = null;
      } else if (tokens.length === 2) {
        next = parsePair(tokens);
      } else if (tokens.length === 0 && ctx.hasUI) {
        const choice = await ctx.ui.select(
          pair ? `Delegate alternate: ${pair.map(delegateModelLabel).join(" ↔ ")}` : "Delegate alternate: disabled",
          ["Disabled", "Choose model pair"], { signal: ctx.signal },
        );
        if (choice === undefined) return;
        if (choice === "Disabled") next = null;
        else {
          const models = [...new Set(ctx.modelRegistry.getAvailable().map(delegateModelLabel))].sort();
          if (models.length < 2) throw new Error("At least two authenticated models are required to enable alternate delegation.");
          const first = await ctx.ui.select("First model in the pair", models, { signal: ctx.signal });
          if (first === undefined) return;
          const second = await ctx.ui.select("Second model in the pair", models.filter((model) => model !== first), { signal: ctx.signal });
          if (second === undefined) return;
          next = parsePair([first, second]);
        }
      } else {
        throw new Error("Usage: /delegate-alt [off|status|provider/model provider/model]. Omit arguments in TUI/RPC for a picker.");
      }
      if (next) {
        for (const ref of next) {
          const model = ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === ref.provider && candidate.id === ref.id);
          if (!model) throw new Error(`Model unavailable: ${delegateModelLabel(ref)}.`);
          modelCliArgs(model, "off"); // Refuse identifiers the child CLI cannot resolve exactly.
        }
      }
      save(next);
      refresh(ctx);
      report(ctx);
    },
  });
  // Refresh before prompt construction; no watcher, polling, or scope-change hook is needed.
  pi.on("session_start", async (_event, ctx) => { refresh(ctx); });
  pi.on("input", async (_event, ctx) => { refresh(ctx); });

  return {
    resolve(ctx, alt) {
      refresh(ctx);
      if (alt && lastError) throw new Error(lastError);
      return resolveDelegateModel(ctx, pair, alt);
    },
  };
}
