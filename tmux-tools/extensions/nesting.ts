import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NESTING_ENV = "PI_NESTED";
const MAX_NESTING_DEPTH = 4;
const TOO_DEEP_MESSAGE =
  "Pi instances are being nested too deep - implement this yourself, do not pass the problem off to further subagents.";

function parseInheritedDepth(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const PROCESS_SENTINEL = Symbol.for("pi-tmux:nesting-initialized");

function getCurrentDepth(): number {
  const existing = parseInheritedDepth(process.env[NESTING_ENV]);
  return existing ?? 0;
}

function initializeProcessDepth(): number {
  if ((globalThis as { [PROCESS_SENTINEL]?: boolean })[PROCESS_SENTINEL]) {
    return getCurrentDepth();
  }

  (globalThis as { [PROCESS_SENTINEL]?: boolean })[PROCESS_SENTINEL] = true;
  const inheritedDepth = parseInheritedDepth(process.env[NESTING_ENV]);
  const currentDepth = inheritedDepth === undefined ? 0 : inheritedDepth + 1;
  process.env[NESTING_ENV] = String(currentDepth);
  return currentDepth;
}

const currentDepth = initializeProcessDepth();

if (currentDepth >= MAX_NESTING_DEPTH) {
  process.stderr.write(`${TOO_DEEP_MESSAGE}\n`);
  process.exit(1);
}

export default function (_pi: ExtensionAPI) {
  // Mutating process.env at module load is the important behavior: child pi
  // processes inherit PI_NESTED and will increment it again when this extension
  // loads. The extension factory intentionally has no runtime hooks.
}
