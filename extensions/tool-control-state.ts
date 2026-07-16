export const TOOL_CONTROL_STATE_TYPE = "pi-ant:tool-control";
export const TOOL_CONTROL_EVENT = "pi-ant:tool-control-changed";

const CORE_TOOLS = ["read", "bash", "edit", "write", "grep"] as const;
const WORKER_TOOLS = ["ask", "delegate"] as const;
const WEB_TOOLS = ["browser", "web_search", "web_fetch"] as const;
const ORCHESTRATION_TOOLS = [
  "herdr-bash",
  "herdr-capture",
  "herdr-send",
  "coding-agent",
  "fresh-history",
] as const;
const OPTIONAL_BUILTIN_TOOLS = ["find", "ls"] as const;
const BOBS_ROOT_TOOLS = ["delegate", "coding-agent", "ask", "fresh-history"] as const;

export const TOOL_PROFILES = {
  coding: {
    label: "Coding",
    description: "Core coding and delegated-worker tools",
    tools: [...CORE_TOOLS, ...WORKER_TOOLS],
  },
  research: {
    label: "Research",
    description: "Coding, delegated workers, browser, and web tools",
    tools: [...CORE_TOOLS, ...WORKER_TOOLS, ...WEB_TOOLS],
  },
  orchestration: {
    label: "Orchestration",
    description: "Coding, delegated workers, and Herdr orchestration tools",
    tools: [...CORE_TOOLS, ...WORKER_TOOLS, ...ORCHESTRATION_TOOLS],
  },
  full: {
    label: "Full",
    description: "All ordinary coding, web, worker, and orchestration tools",
    tools: [
      ...CORE_TOOLS,
      ...OPTIONAL_BUILTIN_TOOLS,
      ...WORKER_TOOLS,
      ...WEB_TOOLS,
      ...ORCHESTRATION_TOOLS,
    ],
  },
  bobs: {
    label: "Bob's",
    description: "Delegation-only root; inherited delegates receive the Research profile",
    tools: [...BOBS_ROOT_TOOLS],
    delegatedTools: [...CORE_TOOLS, ...WORKER_TOOLS, ...WEB_TOOLS],
  },
} as const;

export type ToolProfileName = keyof typeof TOOL_PROFILES;

export interface ToolControlState {
  profile: ToolProfileName;
  enabledTools: string[];
  updatedAt: string;
}

export interface ToolControlEvent {
  profile: ToolProfileName;
  enabledTools: string[];
  delegatedTools?: string[];
}

export const DEFAULT_TOOL_PROFILE: ToolProfileName = "research";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isToolProfileName(value: unknown): value is ToolProfileName {
  return typeof value === "string" && Object.hasOwn(TOOL_PROFILES, value);
}

export function createProfileState(profile: ToolProfileName, updatedAt = new Date().toISOString()): ToolControlState {
  return {
    profile,
    enabledTools: [...TOOL_PROFILES[profile].tools],
    updatedAt,
  };
}

export function parseToolControlState(value: unknown): ToolControlState | undefined {
  if (!isRecord(value) || !isToolProfileName(value.profile) || typeof value.updatedAt !== "string") return undefined;
  if (!Array.isArray(value.enabledTools) || !value.enabledTools.every((tool) => typeof tool === "string")) return undefined;
  return {
    profile: value.profile,
    enabledTools: [...new Set(value.enabledTools)],
    updatedAt: value.updatedAt,
  };
}

export function toolControlStatesEqual(left: ToolControlState, right: ToolControlState): boolean {
  if (left.profile !== right.profile || left.enabledTools.length !== right.enabledTools.length) return false;
  const rightTools = new Set(right.enabledTools);
  return left.enabledTools.every((tool) => rightTools.has(tool));
}

export function profileIsModified(state: ToolControlState): boolean {
  return !toolControlStatesEqual(state, createProfileState(state.profile, state.updatedAt));
}

export function activeToolsForState(
  state: ToolControlState,
  availableTools: Iterable<string>,
  requiredTools: Iterable<string>,
): string[] {
  const available = new Set(availableTools);
  return [...new Set([...state.enabledTools, ...requiredTools])].filter((tool) => available.has(tool));
}

export function eventForState(state: ToolControlState, availableTools: Iterable<string>): ToolControlEvent {
  const available = new Set(availableTools);
  const enabledTools = state.enabledTools.filter((tool) => available.has(tool));
  const profile = TOOL_PROFILES[state.profile];
  const delegated = "delegatedTools" in profile ? profile.delegatedTools : undefined;
  return {
    profile: state.profile,
    enabledTools,
    delegatedTools: delegated?.filter((tool: string) => available.has(tool)),
  };
}
