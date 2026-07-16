export const DELEGATE_CONTEXTS = ["inherit", "project", "clean"] as const;
const INHERIT_CONTEXT_WARNING_THRESHOLD_PERCENT = 50;

export type DelegateContext = (typeof DELEGATE_CONTEXTS)[number];

export function inheritContextWarningPercent(
  context: DelegateContext,
  contextPercent: number | null | undefined,
  warningWasReturned: boolean,
): number | undefined {
  if (
    context !== "inherit"
    || warningWasReturned
    || contextPercent === null
    || contextPercent === undefined
    || contextPercent <= INHERIT_CONTEXT_WARNING_THRESHOLD_PERCENT
  ) {
    return undefined;
  }
  return contextPercent;
}

export function cleanContextCliArgs(context: Exclude<DelegateContext, "inherit">, workerFrameExtensionPath: string): string[] {
  if (context === "project") return [];
  return [
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--no-approve",
    "--system-prompt",
    "",
    "--append-system-prompt",
    "",
    "--extension",
    workerFrameExtensionPath,
  ];
}

export function withoutDelegateTool(tools: string[]): string[] {
  return tools.filter((tool) => tool !== "delegate");
}
