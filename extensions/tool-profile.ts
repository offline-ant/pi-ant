import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROFILE_STATE_TYPE = "pi-ant:tool-profile";
const DEFAULT_PROFILE: ToolProfile = "research";

const CORE_TOOLS = ["read", "bash", "edit", "write", "grep"] as const;
const WORKER_TOOLS = ["ask", "call", "minitask"] as const;
const WEB_TOOLS = ["browser", "web_search", "web_fetch"] as const;
const ORCHESTRATION_TOOLS = [
  "herdr-bash",
  "herdr-capture",
  "herdr-send",
  "herdr-close",
  "coding-agent",
  "fresh-history",
] as const;
const OPTIONAL_BUILTIN_TOOLS = ["find", "ls"] as const;

const PROFILE_TOOLS = {
  coding: [...CORE_TOOLS, ...WORKER_TOOLS],
  research: [...CORE_TOOLS, ...WORKER_TOOLS, ...WEB_TOOLS],
  orchestration: [...CORE_TOOLS, ...WORKER_TOOLS, ...ORCHESTRATION_TOOLS],
  full: [...CORE_TOOLS, ...OPTIONAL_BUILTIN_TOOLS, ...WORKER_TOOLS, ...WEB_TOOLS, ...ORCHESTRATION_TOOLS],
} as const;

type ToolProfile = keyof typeof PROFILE_TOOLS;

interface ToolProfileState {
  profile: ToolProfile;
  updatedAt: string;
}

interface CustomEntryLike {
  customType?: string;
  data?: unknown;
}

const MANAGED_TOOLS = new Set<string>([
  ...Object.values(PROFILE_TOOLS).flat(),
  "present_guidance",
  "sqlite",
]);
const STRUCTURED_WORKER_TYPES = new Set([
  "pi-herdr:call-runtime",
  "pi-herdr:coding-agent",
  "pi-herdr:minitask",
  "pi-herdr:fresh-history",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToolProfile(value: unknown): value is ToolProfile {
  return value === "coding" || value === "research" || value === "orchestration" || value === "full";
}

function customEntries(ctx: ExtensionContext): CustomEntryLike[] {
  return ctx.sessionManager.getBranch().filter(
    (entry): entry is typeof entry & { customType: string } => entry.type === "custom" && typeof entry.customType === "string",
  );
}

function latestProfile(ctx: ExtensionContext): ToolProfile {
  const entries = customEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== PROFILE_STATE_TYPE || !isRecord(entry.data) || !isToolProfile(entry.data.profile)) continue;
    return entry.data.profile;
  }
  return DEFAULT_PROFILE;
}

function isStructuredWorker(ctx: ExtensionContext): boolean {
  return customEntries(ctx).some((entry) => STRUCTURED_WORKER_TYPES.has(entry.customType ?? ""));
}

function isBobsMode(ctx: ExtensionContext): boolean {
  const entries = customEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== "pi-herdr:call-state" || !isRecord(entry.data)) continue;
    return entry.data.bobsMode === true;
  }
  return false;
}

function isActiveUgo(ctx: ExtensionContext): boolean {
  const entries = customEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== "pi-ant:ugo-state" || !isRecord(entry.data)) continue;
    return entry.data.active === true;
  }
  return false;
}

function profileControlsSession(ctx: ExtensionContext): boolean {
  return !isStructuredWorker(ctx) && !isBobsMode(ctx) && !isActiveUgo(ctx);
}

function applyProfile(pi: ExtensionAPI, ctx: ExtensionContext, profile: ToolProfile): string[] {
  if (!profileControlsSession(ctx)) return pi.getActiveTools();

  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const unmanagedActive = pi.getActiveTools().filter((tool) => !MANAGED_TOOLS.has(tool));
  const dynamicTools = [
    available.has("present_guidance") ? "present_guidance" : undefined,
    available.has("sqlite") && existsSync(path.join(ctx.cwd, "AGENTS.db")) ? "sqlite" : undefined,
  ].filter((tool): tool is string => tool !== undefined);
  const selected = PROFILE_TOOLS[profile].filter((tool) => available.has(tool));
  const active = [...new Set([...selected, ...unmanagedActive, ...dynamicTools])];
  pi.setActiveTools(active);
  return active;
}

function parseProfile(input: string): ToolProfile | "status" | undefined {
  const value = input.trim().toLowerCase();
  if (!value || value === "status") return "status";
  if (value === "web") return "research";
  return isToolProfile(value) ? value : undefined;
}

export default function toolProfileExtension(pi: ExtensionAPI): void {
  let currentProfile: ToolProfile = DEFAULT_PROFILE;

  function refresh(ctx: ExtensionContext): void {
    currentProfile = latestProfile(ctx);
    applyProfile(pi, ctx, currentProfile);
    const status = profileControlsSession(ctx) ? ctx.ui.theme.fg("accent", `tools:${currentProfile}`) : undefined;
    ctx.ui.setStatus("tool-profile", status);
  }

  pi.registerCommand("tool-profile", {
    description: "Select active tools. Usage: /tool-profile [status|coding|research|web|orchestration|full]",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trim().toLowerCase();
      const options = ["status", "coding", "research", "web", "orchestration", "full"];
      const matches = options.filter((option) => option.startsWith(value)).map((option) => ({ value: option, label: option }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const profile = parseProfile(args);
      if (!profile) {
        ctx.ui.notify("Usage: /tool-profile [status|coding|research|web|orchestration|full]", "error");
        return;
      }
      if (profile === "status") {
        currentProfile = latestProfile(ctx);
        ctx.ui.notify(`tool-profile: ${currentProfile}; active: ${pi.getActiveTools().join(", ")}`, "info");
        return;
      }

      currentProfile = profile;
      const state: ToolProfileState = { profile, updatedAt: new Date().toISOString() };
      pi.appendEntry(PROFILE_STATE_TYPE, state);
      const controlsSession = profileControlsSession(ctx);
      const active = applyProfile(pi, ctx, profile);
      ctx.ui.setStatus("tool-profile", controlsSession ? ctx.ui.theme.fg("accent", `tools:${profile}`) : undefined);
      const suffix = controlsSession ? ` Active: ${active.join(", ")}.` : " It will apply when the current specialized mode ends.";
      ctx.ui.notify(`tool-profile set to ${profile}.${suffix}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("input", async (_event, ctx) => {
    currentProfile = latestProfile(ctx);
    applyProfile(pi, ctx, currentProfile);
  });
}
