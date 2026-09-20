export const EPHEMERAL_WORKER_CONTEXTS = {
  do: "inherit",
  delegate: "project",
  fresh_look: "clean",
} as const;
const INHERIT_CONTEXT_WARNING_THRESHOLD_PERCENT = 90;

export type EphemeralWorkerTool = keyof typeof EPHEMERAL_WORKER_CONTEXTS;
export type DelegateContext = (typeof EPHEMERAL_WORKER_CONTEXTS)[EphemeralWorkerTool];

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

/**
 * Clean context blanks the worker's *conversation*: no discovered instructions,
 * skills, or prompt templates, and no system prompt.
 *
 * Extensions stay loaded, because they are runtime capability rather than
 * conversation context. Providers are registered by extensions, so disabling
 * discovery left a worker unable to reach its own model whenever the parent ran
 * an extension-registered provider: the child exited during startup with
 * `Unknown provider`, before it could read the task.
 */
export function cleanContextCliArgs(context: Exclude<DelegateContext, "inherit">, workerFrameExtensionPath: string): string[] {
  if (context === "project") return [];
  return [
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    "--system-prompt",
    "",
    "--append-system-prompt",
    "",
    "--extension",
    workerFrameExtensionPath,
  ];
}
