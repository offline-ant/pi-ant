import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL_CONTROL_EVENT = "pi-ant:tool-control-changed";
const DELEGATE_TOOL = "delegate";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

export interface WorkerToolResolver {
  current(): string[];
  dispose(): void;
}

export function createWorkerToolResolver(pi: ExtensionAPI): WorkerToolResolver {
  let delegatedTools: string[] | undefined;
  const unsubscribe = pi.events.on(TOOL_CONTROL_EVENT, (value: unknown) => {
    if (!isRecord(value)) return;
    delegatedTools = stringArray(value.delegatedTools);
  });

  return {
    current: () => [...new Set([...(delegatedTools ?? pi.getActiveTools()), DELEGATE_TOOL])],
    dispose: unsubscribe,
  };
}
