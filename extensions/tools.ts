import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  getAgentDir,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  type KeybindingsManager,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  activeToolsForState,
  createProfileState,
  DEFAULT_TOOL_PROFILE,
  eventForState,
  parseToolControlState,
  profileIsModified,
  TOOL_CONTROL_EVENT,
  TOOL_CONTROL_STATE_TYPE,
  TOOL_PROFILES,
  toolControlStatesEqual,
  type ToolControlState,
  type ToolProfileName,
} from "./tool-control-state.ts";

const REQUIRED_DYNAMIC_TOOLS = ["present_guidance", "sqlite"] as const;
const SAVED_DEFAULT_PATH = path.join(getAgentDir(), "tool-selection.json");
const STRUCTURED_WORKER_TYPES = new Set([
  "pi-herdr:call-runtime",
  "pi-herdr:coding-agent",
  "pi-herdr:minitask",
  "pi-herdr:fresh-history",
]);
const BOBS_INSTRUCTIONS =
  "Root orchestration mode: delegate repository or environment work rather than doing it here. Use call for current context, coding-agent for persistent fresh context, minitask for isolated work, fresh-history for a recent excerpt, and ask for required decisions. Answer directly only when no inspection or tool work is needed. Call workers receive the deterministic Research tool profile.";

type Tab = "tools" | "profiles";

interface CustomEntryLike {
  customType?: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function customEntries(ctx: ExtensionContext): CustomEntryLike[] {
  return ctx.sessionManager.getBranch().filter(
    (entry): entry is typeof entry & { customType: string } => entry.type === "custom" && typeof entry.customType === "string",
  );
}

function loadSavedDefault(): ToolControlState {
  try {
    const state = parseToolControlState(JSON.parse(readFileSync(SAVED_DEFAULT_PATH, "utf8")) as unknown);
    if (state) return state;
  } catch {
    // Missing or malformed saved defaults fall back to the built-in default profile.
  }
  return createProfileState(DEFAULT_TOOL_PROFILE);
}

function saveDefault(state: ToolControlState): void {
  mkdirSync(path.dirname(SAVED_DEFAULT_PATH), { recursive: true, mode: 0o700 });
  const saved = { ...state, enabledTools: [...state.enabledTools], updatedAt: new Date().toISOString() };
  const temporaryPath = `${SAVED_DEFAULT_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(saved, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, SAVED_DEFAULT_PATH);
}

function latestState(ctx: ExtensionContext, savedDefault: ToolControlState): ToolControlState {
  const entries = customEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== TOOL_CONTROL_STATE_TYPE) continue;
    const state = parseToolControlState(entry.data);
    if (state) return state;
  }
  return { ...savedDefault, enabledTools: [...savedDefault.enabledTools] };
}

function specializedOwner(ctx: ExtensionContext): string | undefined {
  const entries = customEntries(ctx);
  if (entries.some((entry) => STRUCTURED_WORKER_TYPES.has(entry.customType ?? ""))) return "structured worker";
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== "pi-ant:ugo-state" || !isRecord(entry.data)) continue;
    if (entry.data.active === true) return "Ugo";
    break;
  }
  return undefined;
}

function requiredTools(pi: ExtensionAPI, ctx: ExtensionContext): Set<string> {
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const required = new Set<string>();
  if (available.has("present_guidance")) required.add("present_guidance");
  if (available.has("sqlite") && existsSync(path.join(ctx.cwd, "AGENTS.db"))) required.add("sqlite");
  return required;
}

function toolDescription(tool: ToolInfo, required: boolean): string {
  const suffix = required ? " This tool is required by the current workspace or runtime and cannot be disabled here." : "";
  return `${tool.description}${suffix}`;
}

class ToolControlComponent implements Component, Focusable {
  private tab: Tab = "tools";
  private state: ToolControlState;
  private savedDefault: ToolControlState;
  private readonly tools: ToolInfo[];
  private readonly required: Set<string>;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly search = new Input();
  private readonly onStateChange: (state: ToolControlState) => void;
  private readonly onSaveDefault: (state: ToolControlState) => boolean;
  private readonly requestRender: () => void;
  private readonly onClose: () => void;
  private selectedTool = 0;
  private selectedProfile = 0;
  private _focused = false;

  constructor(options: {
    state: ToolControlState;
    savedDefault: ToolControlState;
    tools: ToolInfo[];
    required: Set<string>;
    theme: Theme;
    keybindings: KeybindingsManager;
    onStateChange: (state: ToolControlState) => void;
    onSaveDefault: (state: ToolControlState) => boolean;
    requestRender: () => void;
    onClose: () => void;
  }) {
    this.state = options.state;
    this.savedDefault = options.savedDefault;
    this.tools = options.tools;
    this.required = options.required;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.onStateChange = options.onStateChange;
    this.onSaveDefault = options.onSaveDefault;
    this.requestRender = options.requestRender;
    this.onClose = options.onClose;
    this.selectedProfile = toolControlStatesEqual(this.state, this.savedDefault)
      ? 0
      : Object.keys(TOOL_PROFILES).indexOf(this.state.profile) + 1;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value && this.tab === "tools";
  }

  private filteredTools(): ToolInfo[] {
    const query = this.search.getValue();
    return query ? fuzzyFilter(this.tools, query, (tool) => `${tool.name} ${tool.description}`) : this.tools;
  }

  private move(delta: number): void {
    const length = this.tab === "tools" ? this.filteredTools().length : Object.keys(TOOL_PROFILES).length + 1;
    if (length === 0) return;
    if (this.tab === "tools") this.selectedTool = (this.selectedTool + delta + length) % length;
    else this.selectedProfile = (this.selectedProfile + delta + length) % length;
  }

  private activate(): void {
    if (this.tab === "profiles") {
      if (this.selectedProfile === 0) {
        this.state = { ...this.savedDefault, enabledTools: [...this.savedDefault.enabledTools], updatedAt: new Date().toISOString() };
        this.onStateChange(this.state);
        return;
      }
      const profile = Object.keys(TOOL_PROFILES)[this.selectedProfile - 1] as ToolProfileName | undefined;
      if (!profile) return;
      this.state = createProfileState(profile);
      this.onStateChange(this.state);
      return;
    }

    const tool = this.filteredTools()[this.selectedTool];
    if (!tool || this.required.has(tool.name)) return;
    const enabled = new Set(this.state.enabledTools);
    if (enabled.has(tool.name)) enabled.delete(tool.name);
    else enabled.add(tool.name);
    this.state = {
      ...this.state,
      enabledTools: [...enabled],
      updatedAt: new Date().toISOString(),
    };
    this.onStateChange(this.state);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.tab = this.tab === "tools" ? "profiles" : "tools";
      this.search.focused = this._focused && this.tab === "tools";
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.move(-1);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.move(1);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.activate();
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "app.models.save")) {
      if (this.onSaveDefault(this.state)) {
        this.savedDefault = { ...this.state, enabledTools: [...this.state.enabledTools] };
      }
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onClose();
      return;
    }
    if (this.tab === "tools") {
      this.search.handleInput(data);
      this.selectedTool = 0;
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const modified = profileIsModified(this.state) ? " modified" : "";
    const unsaved = toolControlStatesEqual(this.state, this.savedDefault) ? "" : " · unsaved default";
    lines.push(this.theme.fg("accent", this.theme.bold("Tool Configuration")));
    lines.push(this.theme.fg("muted", `Session branch · ${this.state.profile}${modified}${unsaved}`));
    lines.push("");
    const toolsTab = this.tab === "tools" ? this.theme.fg("accent", this.theme.bold("[Tools]")) : " Tools ";
    const profilesTab = this.tab === "profiles" ? this.theme.fg("accent", this.theme.bold("[Profiles]")) : " Profiles ";
    lines.push(truncateToWidth(`${toolsTab}  ${profilesTab}  ${this.theme.fg("dim", "Tab switches")}`, width));
    lines.push("");

    if (this.tab === "profiles") this.renderProfiles(lines, width);
    else this.renderTools(lines, width);

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderTools(lines: string[], width: number): void {
    lines.push(...this.search.render(width));
    lines.push("");
    const tools = this.filteredTools();
    if (tools.length === 0) {
      lines.push(this.theme.fg("muted", "  No matching tools"));
    } else {
      const maxVisible = 10;
      const start = Math.max(0, Math.min(this.selectedTool - Math.floor(maxVisible / 2), tools.length - maxVisible));
      const end = Math.min(start + maxVisible, tools.length);
      for (let index = start; index < end; index++) {
        const tool = tools[index];
        if (!tool) continue;
        const selected = index === this.selectedTool;
        const enabled = this.required.has(tool.name) || this.state.enabledTools.includes(tool.name);
        const cursor = selected ? this.theme.fg("accent", "→ ") : "  ";
        const name = selected ? this.theme.fg("accent", tool.name) : tool.name;
        const status = this.required.has(tool.name)
          ? this.theme.fg("warning", "required")
          : enabled
            ? this.theme.fg("success", "enabled")
            : this.theme.fg("dim", "disabled");
        lines.push(`${cursor}${name}  ${status}`);
      }
      if (start > 0 || end < tools.length) lines.push(this.theme.fg("dim", `  (${this.selectedTool + 1}/${tools.length})`));
      const selected = tools[this.selectedTool];
      if (selected) {
        lines.push("");
        lines.push(...wrapTextWithAnsi(toolDescription(selected, this.required.has(selected.name)), Math.max(1, width - 4)).map((line) => `  ${this.theme.fg("muted", line)}`));
      }
    }
    lines.push("");
    lines.push(this.theme.fg("dim", `  Type to search · Enter toggles · Tab profiles · ${keyHint("app.models.save", "save default")} · Esc closes`));
  }

  private renderProfiles(lines: string[], width: number): void {
    const defaultSelected = this.selectedProfile === 0;
    const defaultCursor = defaultSelected ? this.theme.fg("accent", "→ ") : "  ";
    const defaultLabel = defaultSelected ? this.theme.fg("accent", "Default") : "Default";
    const defaultActive = toolControlStatesEqual(this.state, this.savedDefault) ? this.theme.fg("success", " active") : "";
    lines.push(`${defaultCursor}${defaultLabel}${defaultActive}`);
    if (defaultSelected) {
      lines.push(this.theme.fg("muted", "  Saved global default for new sessions"));
    }

    const profiles = Object.entries(TOOL_PROFILES) as Array<[ToolProfileName, (typeof TOOL_PROFILES)[ToolProfileName]]>;
    for (let index = 0; index < profiles.length; index++) {
      const [name, profile] = profiles[index];
      const selected = index + 1 === this.selectedProfile;
      const cursor = selected ? this.theme.fg("accent", "→ ") : "  ";
      const label = selected ? this.theme.fg("accent", profile.label) : profile.label;
      const active = name === this.state.profile ? this.theme.fg("success", profileIsModified(this.state) ? " active*" : " active") : "";
      lines.push(`${cursor}${label}${active}`);
      if (selected) {
        lines.push(...wrapTextWithAnsi(profile.description, Math.max(1, width - 4)).map((line) => `  ${this.theme.fg("muted", line)}`));
      }
    }
    lines.push("");
    lines.push(this.theme.fg("dim", `  Enter applies profile · ${keyHint("app.models.save", "save default")} · Tab tools · Esc closes`));
  }

  invalidate(): void {
    this.search.invalidate();
  }
}

export default function toolsExtension(pi: ExtensionAPI): void {
  let savedDefault = loadSavedDefault();
  let currentState = { ...savedDefault, enabledTools: [...savedDefault.enabledTools] };

  function applyState(ctx: ExtensionContext, state: ToolControlState): string[] {
    currentState = state;
    if (specializedOwner(ctx)) return pi.getActiveTools();
    const allTools = pi.getAllTools();
    const available = allTools.map((tool) => tool.name);
    const active = activeToolsForState(state, available, requiredTools(pi, ctx));
    pi.setActiveTools(active);
    pi.events.emit(TOOL_CONTROL_EVENT, eventForState(state, available));
    const suffix = profileIsModified(state) ? "*" : "";
    ctx.ui.setStatus("tools", ctx.ui.theme.fg("accent", `tools:${state.profile}${suffix}`));
    return active;
  }

  function refresh(ctx: ExtensionContext): void {
    savedDefault = loadSavedDefault();
    currentState = latestState(ctx, savedDefault);
    const owner = specializedOwner(ctx);
    if (owner) {
      ctx.ui.setStatus("tools", undefined);
      return;
    }
    applyState(ctx, currentState);
  }

  function persistAndApply(ctx: ExtensionContext, state: ToolControlState): void {
    pi.appendEntry(TOOL_CONTROL_STATE_TYPE, state);
    applyState(ctx, state);
  }

  pi.registerCommand("tools", {
    description: "Interactively enable tools or apply a tool profile",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tools requires TUI mode", "error");
        return;
      }
      const owner = specializedOwner(ctx);
      if (owner) {
        ctx.ui.notify(`Tools are currently controlled by ${owner}.`, "warning");
        return;
      }

      savedDefault = loadSavedDefault();
      currentState = latestState(ctx, savedDefault);
      const tools = pi.getAllTools().sort((left, right) => left.name.localeCompare(right.name));
      const required = requiredTools(pi, ctx);
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => new ToolControlComponent({
        state: currentState,
        savedDefault,
        tools,
        required,
        theme,
        keybindings,
        onStateChange: (state) => {
          currentState = state;
          persistAndApply(ctx, state);
        },
        onSaveDefault: (state) => {
          try {
            saveDefault(state);
            savedDefault = { ...state, enabledTools: [...state.enabledTools] };
            ctx.ui.notify(`Saved default tool selection to ${SAVED_DEFAULT_PATH}`, "info");
            return true;
          } catch (error) {
            ctx.ui.notify(`Could not save default tool selection: ${error instanceof Error ? error.message : String(error)}`, "error");
            return false;
          }
        },
        requestRender: () => tui.requestRender(),
        onClose: () => done(undefined),
      }));
    },
  });

  pi.on("session_start", async (_event, ctx) => refresh(ctx));
  pi.on("session_tree", async (_event, ctx) => refresh(ctx));
  pi.on("input", async (_event, ctx) => refresh(ctx));

  pi.on("before_agent_start", async (event, ctx) => {
    if (specializedOwner(ctx) || currentState.profile !== "bobs") return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${BOBS_INSTRUCTIONS}` };
  });
}
