const NESTING_ENV = "PI_NESTED";
const MAX_NESTING_DEPTH = 4;
const PROCESS_DEPTH = Symbol.for("pi-orchestration:nesting-depth");

function inheritedDepth(): number | undefined {
  const value = process.env[NESTING_ENV];
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Activate once at session startup, including clean worker sessions and reloads. */
export function initializeNesting(): number {
  const globals = globalThis as typeof globalThis & { [PROCESS_DEPTH]?: number };
  if (globals[PROCESS_DEPTH] === undefined) {
    const parent = inheritedDepth();
    globals[PROCESS_DEPTH] = parent === undefined ? 0 : parent + 1;
    process.env[NESTING_ENV] = String(globals[PROCESS_DEPTH]);
  }
  return globals[PROCESS_DEPTH];
}

/** Check before native creation; reaching the limit never terminates the parent. */
export function childNestingEnvironment(): Record<string, string> {
  const globals = globalThis as typeof globalThis & { [PROCESS_DEPTH]?: number };
  const depth = globals[PROCESS_DEPTH] ?? inheritedDepth() ?? 0;
  if (depth + 1 >= MAX_NESTING_DEPTH) {
    throw new Error("Pi instances are being nested too deep - implement this yourself, do not pass the problem off to further subagents.");
  }
  // Children increment the inherited parent depth when their session starts.
  return { [NESTING_ENV]: String(depth) };
}
