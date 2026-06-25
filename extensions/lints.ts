/**
 * Unified linting extension for pi
 * Combines python-ty, shellcheck, and rust-style-checker.
 *
 * - Python: runs ty (https://github.com/astral-sh/ty) on .py files
 * - Shell:  runs shellcheck on scripts with bash/sh shebangs
 * - Rust:   warns about String::from_utf8_lossy without explicit justification in .rs files
 *
 * Warnings are attached to successful write/edit tool results so they stay in
 * tool-output semantics instead of becoming follow-up user prompts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  isEditToolResult,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LintSource = "python-ty" | "shellcheck" | "rust-style-checker";

interface LintWarning {
  source: LintSource;
  filePath: string;
  summary: string;
  diagnostics: string[];
}

interface LintAwareDetails {
  lintWarnings?: LintWarning[];
  [key: string]: unknown;
}

interface LintRenderState {
  baseResultComponent?: Component;
}

interface WarningTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const SHEBANG_PATTERNS = [
  /^#!.*\/bash\s*$/,
  /^#!.*\/sh\s*$/,
  /^#!.*\/env\s+(bash|sh)(?:\s|$)/,
];

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveFilePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function readFileText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

function isShellScript(text: string): boolean {
  const firstLine = text.split("\n")[0] || "";
  return SHEBANG_PATTERNS.some((pattern) => pattern.test(firstLine));
}

function mergeLintWarnings(details: unknown, warnings: LintWarning[]): LintAwareDetails {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const lintWarnings = (details as LintAwareDetails).lintWarnings;
    const existingWarnings = Array.isArray(lintWarnings) ? lintWarnings : [];
    return {
      ...(details as Record<string, unknown>),
      lintWarnings: [...existingWarnings, ...warnings],
    };
  }

  return { lintWarnings: warnings };
}

function getLintWarnings(details: unknown): LintWarning[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const warnings = (details as LintAwareDetails).lintWarnings;
  return Array.isArray(warnings) ? warnings : [];
}

function formatToolWarningMessage(toolName: string, filePath: string, warnings: LintWarning[]): string {
  const sections = warnings.map((warning) => {
    const diagnostics = warning.diagnostics.map((line) => `  ${line}`).join("\n");
    return `[${warning.source}] ${warning.summary}\n${diagnostics}`;
  });

  return [
    `AUTOMATED TOOL WARNING for ${filePath}`,
    `This is automated tool feedback attached to the successful ${toolName} result, not a user request.`,
    "Resolve the issues below in your next step, then continue with the task.",
    "Do not stop just to acknowledge this warning.",
    "",
    ...sections,
  ].join("\n");
}

function formatToolWarningDisplay(warnings: LintWarning[], theme: WarningTheme): string {
  let text = theme.fg("warning", theme.bold("Automated tool warning"));

  for (const warning of warnings) {
    text += `\n${theme.fg("warning", `[${warning.source}] ${warning.summary}`)}`;
    for (const line of warning.diagnostics) {
      text += `\n${theme.fg("dim", line)}`;
    }
  }

  return text;
}

// ---------------------------------------------------------------------------
// Python (ty)
// ---------------------------------------------------------------------------

function collectPythonTyWarning(hasTy: boolean, absolutePath: string, filePath: string): LintWarning | undefined {
  if (!hasTy || !filePath.endsWith(".py")) return undefined;

  const result = spawnSync(
    "ty",
    ["check", "--output-format", "concise", "--color", "never", absolutePath],
    {
      encoding: "utf-8",
      cwd: path.dirname(absolutePath),
      timeout: 30000,
    },
  );

  if (result.status === 0) return undefined;

  const output = ((result.stdout || "") + (result.stderr || "")).trim();
  if (!output) return undefined;

  const diagnostics = output
    .split("\n")
    .filter((line) => !line.startsWith("Found ") || !line.endsWith("diagnostics"));
  if (diagnostics.length === 0) return undefined;

  return {
    source: "python-ty",
    filePath,
    summary: `ty found Python type errors in ${filePath}.`,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Shellcheck
// ---------------------------------------------------------------------------

function collectShellcheckWarning(
  hasShellcheck: boolean,
  absolutePath: string,
  filePath: string,
): LintWarning | undefined {
  if (!hasShellcheck) return undefined;

  const text = readFileText(absolutePath);
  if (!text || !isShellScript(text)) return undefined;

  const result = spawnSync("shellcheck", ["-x", "-P", "SCRIPTDIR", absolutePath], {
    encoding: "utf-8",
    cwd: path.dirname(absolutePath),
  });

  if (result.status === 0) return undefined;

  const output = ((result.stdout || "") + (result.stderr || "")).trim();
  if (!output) return undefined;

  return {
    source: "shellcheck",
    filePath,
    summary: `shellcheck found shell issues in ${filePath}.`,
    diagnostics: output.split("\n"),
  };
}

// ---------------------------------------------------------------------------
// Rust style checker (String::from_utf8_lossy)
// ---------------------------------------------------------------------------

/**
 * Check text for String::from_utf8_lossy without a justification comment.
 * Returns warning lines (empty array if clean).
 */
function checkLossyUsage(text: string): string[] {
  const lines = text.split("\n");
  const warnings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("String::from_utf8_lossy")) continue;

    const contextStart = Math.max(0, i - 2);
    const contextEnd = Math.min(lines.length - 1, i + 2);

    let hasJustification = false;
    for (let j = contextStart; j <= contextEnd; j++) {
      if (
        lines[j].includes("UTF-8 Lossy:") ||
        (lines[j].includes("//") && lines[j].includes("Lossy"))
      ) {
        hasJustification = true;
        break;
      }
    }
    if (hasJustification) continue;

    warnings.push(line.trim());
  }

  return warnings;
}

function collectRustStyleWarning(absolutePath: string, filePath: string): LintWarning | undefined {
  if (!filePath.endsWith(".rs")) return undefined;

  const text = readFileText(absolutePath);
  if (!text) return undefined;

  const diagnostics = checkLossyUsage(text);
  if (diagnostics.length === 0) return undefined;

  return {
    source: "rust-style-checker",
    filePath,
    summary: `String::from_utf8_lossy needs explicit approval or justification in ${filePath}.`,
    diagnostics: [
      ...diagnostics,
      "String::from_utf8_lossy is usually only appropriate for display/logging where data loss is acceptable.",
      "Prefer String::from_utf8(...) with proper error handling unless the user explicitly approved lossy conversion.",
      "If lossy conversion is truly intended, add a nearby comment: // UTF-8 Lossy: <reason>",
    ],
  };
}

function collectLintWarnings(
  hasTy: boolean,
  hasShellcheck: boolean,
  absolutePath: string,
  filePath: string,
): LintWarning[] {
  const warnings = [
    collectPythonTyWarning(hasTy, absolutePath, filePath),
    collectShellcheckWarning(hasShellcheck, absolutePath, filePath),
    collectRustStyleWarning(absolutePath, filePath),
  ];

  return warnings.filter((warning): warning is LintWarning => warning !== undefined);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const hasTy = commandExists("ty");
  const hasShellcheck = commandExists("shellcheck");
  const cwd = process.cwd();

  if (!hasTy) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.setStatus("ty", "ty not found — install with: uv tool install ty");
      }
    });
  }

  const editTool = createEditToolDefinition(cwd);
  pi.registerTool({
    ...editTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createEditToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderResult(result, options, theme, context) {
      const state = context.state as LintRenderState;
      const baseContext = { ...context, lastComponent: state.baseResultComponent };
      type EditRenderResult = Parameters<NonNullable<typeof editTool.renderResult>>[0];
      const baseComponent = editTool.renderResult?.(result as EditRenderResult, options, theme, baseContext);
      state.baseResultComponent = baseComponent;

      const warnings = getLintWarnings(result.details);
      if (warnings.length === 0) {
        return baseComponent ?? new Container();
      }

      const container = new Container();
      if (baseComponent) {
        container.addChild(baseComponent);
        container.addChild(new Spacer(1));
      }
      container.addChild(new Text(formatToolWarningDisplay(warnings, theme), 0, 0));
      return container;
    },
  });

  const writeTool = createWriteToolDefinition(cwd);
  pi.registerTool({
    ...writeTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createWriteToolDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderResult(result, options, theme, context) {
      const state = context.state as LintRenderState;
      const baseContext = { ...context, lastComponent: state.baseResultComponent };
      type WriteRenderResult = Parameters<NonNullable<typeof writeTool.renderResult>>[0];
      const baseComponent = writeTool.renderResult?.(result as WriteRenderResult, options, theme, baseContext);
      state.baseResultComponent = baseComponent;

      const warnings = getLintWarnings(result.details);
      if (warnings.length === 0) {
        return baseComponent ?? new Container();
      }

      const container = new Container();
      if (baseComponent) {
        container.addChild(baseComponent);
        container.addChild(new Spacer(1));
      }
      container.addChild(new Text(formatToolWarningDisplay(warnings, theme), 0, 0));
      return container;
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    let filePath: string | undefined;
    let toolName: "write" | "edit";

    if (isWriteToolResult(event)) {
      filePath = typeof event.input.path === "string" ? event.input.path : undefined;
      toolName = "write";
    } else if (isEditToolResult(event)) {
      filePath = typeof event.input.path === "string" ? event.input.path : undefined;
      toolName = "edit";
    } else {
      return;
    }

    if (!filePath) return;

    const absolutePath = resolveFilePath(filePath, ctx.cwd);
    if (!fs.existsSync(absolutePath)) return;

    const warnings = collectLintWarnings(hasTy, hasShellcheck, absolutePath, filePath);
    if (warnings.length === 0) return;

    return {
      content: [
        ...event.content,
        {
          type: "text",
          text: formatToolWarningMessage(toolName, filePath, warnings),
        },
      ],
      details: mergeLintWarnings(event.details, warnings),
      isError: false,
    };
  });
}
