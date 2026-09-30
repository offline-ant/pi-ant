import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  activeTools,
  parseToolSelection,
  sameToolSelection,
  toggleTool,
  TOOL_SELECTION_ENTRY,
} from "./tool-selection.ts";

const STRUCTURED_WORKER_TYPES = new Set(["pi-orchestration:delegate-runtime", "pi-orchestration:delegate"]);

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

function savedDefaultPath(): string {
  return path.join(getAgentDir(), "tool-selection.json");
}

/** The global default for new branches; without one, Pi's own active tool set stands. */
function loadSavedDefault(): string[] | undefined {
  try {
    return parseToolSelection(JSON.parse(readFileSync(savedDefaultPath(), "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function saveDefault(selection: readonly string[]): void {
  const file = savedDefaultPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporaryPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ enabledTools: selection }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, file);
}

function branchSelection(ctx: ExtensionContext): string[] | undefined {
  const entries = customEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType !== TOOL_SELECTION_ENTRY) continue;
    const selection = parseToolSelection(entry.data);
    if (selection) return selection;
  }
  return undefined;
}

function specializedOwner(ctx: ExtensionContext): string | undefined {
  const entries = customEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.customType === "pi-orchestration:fork") return undefined;
    if (STRUCTURED_WORKER_TYPES.has(entry.customType ?? "")) return "structured worker";
    if (entry.customType !== "pi-ant:ugo-state" || !isRecord(entry.data)) continue;
    if (entry.data.active === true) return "Ugo";
    break;
  }
  return undefined;
}

function requiredTools(pi: ExtensionAPI): Set<string> {
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const required = new Set<string>();
  if (available.has("present_guidance")) required.add("present_guidance");
  return required;
}

function toolDescription(tool: ToolInfo, required: boolean): string {
  const suffix = required ? " This tool is required by the current workspace or runtime and cannot be disabled here." : "";
  return `${tool.description}${suffix}`;
}

function defaultStatus(selection: readonly string[], savedDefault: readonly string[] | undefined): string {
  if (!savedDefault) return " · no saved default";
  return sameToolSelection(selection, savedDefault) ? " · saved default" : " · differs from saved default";
}

class ToolSelectionComponent implements Component, Focusable {
  private selection: string[];
  private savedDefault: string[] | undefined;
  private readonly tools: ToolInfo[];
  private readonly required: Set<string>;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly search = new Input();
  private readonly onChange: (selection: string[]) => void;
  private readonly onSaveDefault: (selection: string[]) => boolean;
  private readonly requestRender: () => void;
  private readonly onClose: () => void;
  private selectedTool = 0;
  private _focused = false;

  constructor(options: ToolDialogOptions & {
    theme: Theme;
    keybindings: KeybindingsManager;
    requestRender: () => void;
    onClose: () => void;
  }) {
    this.selection = options.selection;
    this.savedDefault = options.savedDefault;
    this.tools = options.tools;
    this.required = options.required;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.onChange = options.onChange;
    this.onSaveDefault = options.onSaveDefault;
    this.requestRender = options.requestRender;
    this.onClose = options.onClose;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  private filteredTools(): ToolInfo[] {
    const query = this.search.getValue();
    return query ? fuzzyFilter(this.tools, query, (tool) => `${tool.name} ${tool.description}`) : this.tools;
  }

  handleInput(data: string): void {
    const tools = this.filteredTools();
    if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down")) {
      const delta = this.keybindings.matches(data, "tui.select.up") ? -1 : 1;
      if (tools.length > 0) this.selectedTool = (this.selectedTool + delta + tools.length) % tools.length;
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const tool = tools[this.selectedTool];
      if (tool && !this.required.has(tool.name)) {
        this.selection = toggleTool(this.selection, tool.name);
        this.onChange(this.selection);
      }
    } else if (this.keybindings.matches(data, "app.models.save")) {
      if (this.onSaveDefault(this.selection)) this.savedDefault = [...this.selection];
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onClose();
      return;
    } else {
      this.search.handleInput(data);
      this.selectedTool = 0;
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold("Tool Configuration")));
    lines.push(this.theme.fg("muted", `Session branch${defaultStatus(this.selection, this.savedDefault)}`));
    lines.push("");
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
        const cursor = selected ? this.theme.fg("accent", "→ ") : "  ";
        const name = selected ? this.theme.fg("accent", tool.name) : tool.name;
        const status = this.required.has(tool.name)
          ? this.theme.fg("warning", "required")
          : this.selection.includes(tool.name)
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
    lines.push(this.theme.fg("dim", `  Type to search · Enter toggles · ${keyHint("app.models.save", "save default")} · Esc closes`));
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    this.search.invalidate();
  }
}

interface ToolDialogOptions {
  selection: string[];
  savedDefault: string[] | undefined;
  tools: ToolInfo[];
  required: Set<string>;
  onChange: (selection: string[]) => void;
  onSaveDefault: (selection: string[]) => boolean;
}

const SAVE_DEFAULT_CHOICE = "Save as default";
const DONE_CHOICE = "Done";

/** Standard RPC dialogs share the TUI's toggle and persistence policy. */
export async function showToolDialog(ctx: ExtensionContext, options: ToolDialogOptions): Promise<void> {
  let selection = options.selection;
  let savedDefault = options.savedDefault;
  while (!ctx.signal?.aborted) {
    const choices = options.tools.map((tool) => ({
      tool,
      label: `${options.required.has(tool.name) ? "[required]" : selection.includes(tool.name) ? "[x]" : "[ ]"} ${tool.name} — ${tool.description}`,
    }));
    const selected = await ctx.ui.select(`Tools${defaultStatus(selection, savedDefault)}`,
      [...choices.map((choice) => choice.label), SAVE_DEFAULT_CHOICE, DONE_CHOICE], { signal: ctx.signal });
    if (!selected || selected === DONE_CHOICE) return;
    if (selected === SAVE_DEFAULT_CHOICE) {
      if (options.onSaveDefault(selection)) savedDefault = [...selection];
      continue;
    }
    const choice = choices.find((item) => item.label === selected);
    if (!choice) continue;
    if (options.required.has(choice.tool.name)) {
      ctx.ui.notify(toolDescription(choice.tool, true), "info");
      continue;
    }
    selection = toggleTool(selection, choice.tool.name);
    options.onChange(selection);
  }
}

export default function toolsExtension(pi: ExtensionAPI): void {
  function apply(selection: readonly string[]): void {
    pi.setActiveTools(activeTools(selection, pi.getAllTools().map((tool) => tool.name), requiredTools(pi)));
  }

  function refresh(ctx: ExtensionContext): void {
    if (specializedOwner(ctx)) return;
    const selection = branchSelection(ctx) ?? loadSavedDefault();
    if (selection) apply(selection);
  }

  pi.registerCommand("tools", {
    description: "Interactively enable or disable tools",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      if (!ctx.hasUI) {
        ctx.ui.notify("/tools requires interactive mode", "error");
        return;
      }
      const owner = specializedOwner(ctx);
      if (owner) {
        ctx.ui.notify(`Tools are currently controlled by ${owner}.`, "warning");
        return;
      }

      const savedDefault = loadSavedDefault();
      const options: ToolDialogOptions = {
        selection: branchSelection(ctx) ?? savedDefault ?? pi.getActiveTools(),
        savedDefault,
        // Hidden tools are withdrawn registrations; Pi never activates them.
        tools: pi.getAllTools().filter((tool) => tool.exposure !== "hidden").sort((left, right) => left.name.localeCompare(right.name)),
        required: requiredTools(pi),
        onChange: (selection) => {
          pi.appendEntry(TOOL_SELECTION_ENTRY, { enabledTools: selection });
          apply(selection);
        },
        onSaveDefault: (selection) => {
          try {
            saveDefault(selection);
            ctx.ui.notify(`Saved default tool selection to ${savedDefaultPath()}`, "info");
            return true;
          } catch (error) {
            ctx.ui.notify(`Could not save default tool selection: ${error instanceof Error ? error.message : String(error)}`, "error");
            return false;
          }
        },
      };
      if (ctx.mode !== "tui") {
        await showToolDialog(ctx, options);
        return;
      }
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => new ToolSelectionComponent({
        ...options,
        theme,
        keybindings,
        requestRender: () => tui.requestRender(),
        onClose: () => done(undefined),
      }));
    },
  });

  pi.on("session_start", async (_event, ctx) => refresh(ctx));
  pi.on("session_tree", async (_event, ctx) => refresh(ctx));
  pi.on("input", async (_event, ctx) => refresh(ctx));
}
