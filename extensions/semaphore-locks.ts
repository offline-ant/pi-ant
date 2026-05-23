/**
 * Semaphore Locks Extension (script-backed)
 *
 * Delegates lock operations to ../bin/pi-semaphore.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const SEMAPHORE_SCRIPT = path.resolve(__dirname, "../bin/pi-semaphore");

export function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._:-]/g, "");
}

function parseNames(args: string | undefined): string[] {
  const raw = args?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(/\s+/)
    .map((name) => sanitizeName(name))
    .filter((name) => name.length > 0);
}

async function runSemaphore(
  pi: ExtensionAPI,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
  return pi.exec("bash", [SEMAPHORE_SCRIPT, ...args], { signal });
}

function resultText(stdout: string, stderr: string): string {
  const out = stdout.trim();
  const err = stderr.trim();

  if (out.length > 0 && err.length > 0) {
    return `${out}\n${err}`;
  }

  const text = out || err;
  return text.length > 0 ? text : "(no output)";
}

const MAX_RETRIES = 3;
const DEFAULT_SEMAPHORE_WAIT_TIMEOUT_SECONDS = 600;

const RETRYABLE_ERROR_PATTERN =
  /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay/i;

/**
 * Check if an agent_end message list ends with a retryable error.
 * Mirrors the logic in agent-session.ts _isRetryableError.
 */
function isRetryableError(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      return msg.stopReason === "error" && !!msg.errorMessage && RETRYABLE_ERROR_PATTERN.test(msg.errorMessage);
    }
  }
  return false;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function didParentLockRelease(text: string, parent: string): boolean {
  const escaped = escapeRegex(parent);
  return new RegExp(`^Lock released:\\s+${escaped}$`, "m").test(text)
    || new RegExp(`^Lock '${escaped}' already idle\\.$`, "m").test(text)
    || new RegExp(`^Lock '${escaped}' already released \\(not found\\)\\.$`, "m").test(text);
}

const semaphoreWaitSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Name of the lock to wait for" })),
  names: Type.Optional(Type.Array(Type.String({ description: "Names of the locks to wait for" }))),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description: "Timeout in seconds before cancelling the wait. Omit it for medium-long tasks; set it when expecting short waits. Values <= 0 wait indefinitely.",
    }),
  ),
});

type SemaphoreWaitParams = Static<typeof semaphoreWaitSchema>;

interface SemaphoreWaitDetails {
  names: string[];
  found: boolean;
  code: number;
  timeoutSeconds: number;
  interrupted?: boolean;
  parentStopped?: string;
  watchLock?: string;
}

function getSemaphoreWaitParams(params: SemaphoreWaitParams): { safeNames: string[]; timeoutSeconds: number } {
  const rawNames = params.names && params.names.length > 0 ? params.names : params.name ? [params.name] : [];
  const safeNames = rawNames.map((name) => sanitizeName(name)).filter((name) => name.length > 0);
  const timeoutSeconds = getTimeoutSeconds(params.timeoutSeconds);
  return { safeNames, timeoutSeconds };
}

function getTimeoutSeconds(timeoutSeconds: number | undefined): number {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) {
    return DEFAULT_SEMAPHORE_WAIT_TIMEOUT_SECONDS;
  }
  return timeoutSeconds <= 0 ? 0 : Math.ceil(timeoutSeconds);
}

function formatSemaphoreWaitArgs(names: string[], timeoutSeconds: number): string {
  return `semaphore_wait(names=[${names.join(", ")}], timeoutSeconds=${timeoutSeconds})`;
}

function formatSemaphoreWaitText(names: string[], timeoutSeconds: number, text: string): string {
  return `${formatSemaphoreWaitArgs(names, timeoutSeconds)}\n${text}`;
}

function formatUserWaitStatus(names: string[], queuedCount: number): string {
  const queued = queuedCount > 0 ? ` (${queuedCount} follow-up${queuedCount === 1 ? "" : "s"} queued)` : "";
  return `Waiting: ${names.join(", ")}${queued}`;
}

function previewText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine;
}

function combineQueuedPrompts(prompts: string[]): string {
  if (prompts.length === 1) {
    return prompts[0];
  }
  return prompts.map((prompt, index) => `Follow-up ${index + 1}:\n${prompt}`).join("\n\n");
}

function createSemaphoreWaitResult(
  names: string[],
  timeoutSeconds: number,
  text: string,
  details: SemaphoreWaitDetails,
): { content: [{ type: "text"; text: string }]; details: SemaphoreWaitDetails } {
  return {
    content: [{ type: "text", text: formatSemaphoreWaitText(names, timeoutSeconds, text) }],
    details,
  };
}

export default function semaphoreLocksExtension(pi: ExtensionAPI) {
  let currentLockName: string | null = null;

  // Track consecutive retryable errors to avoid releasing the lock during auto-retry.
  // pi retries up to MAX_RETRIES times. Each retry triggers agent_end → agent_start.
  // We hold the lock until retries are exhausted or the error clears.
  let retryableErrorCount = 0;

  // Context alert: release a <name>:context lock when context usage >= threshold.
  // Set from PI_CONTEXT_ALERT env var. The lock is created by tmux-coding-agent
  // before pi starts, so we only need to track and release it here.
  const contextAlertThreshold = (() => {
    const raw = parseInt(process.env.PI_CONTEXT_ALERT ?? "", 10);
    return !isNaN(raw) && raw > 0 && raw <= 100 ? raw : null;
  })();
  let contextAlertLockName: string | null = null;
  let contextAlertReleased = false;

  async function releaseContextAlertIfThresholdReached(ctx: ExtensionContext): Promise<void> {
    if (!contextAlertLockName || contextAlertReleased || !contextAlertThreshold) {
      return;
    }

    const usage = ctx.getContextUsage();
    if (usage?.percent !== null && usage?.percent !== undefined && usage.percent >= contextAlertThreshold) {
      await runSemaphore(pi, ["release", contextAlertLockName]);
      contextAlertReleased = true;
    }
  }

  // Abort controller for the currently-running semaphore_wait tool.
  // Set when the tool starts, cleared when it finishes.
  // The input event handler aborts this so a user message interrupts the wait.
  let waitAbortController: AbortController | null = null;

  let activeUserWait: { names: string[]; queuedPrompts: string[]; abortController: AbortController } | null = null;

  // When the user sends a message while semaphore_wait is blocking,
  // abort the wait subprocess so the steering message is delivered promptly.
  // While the user-facing /wait command is blocking, capture prompts instead
  // and send them after the waited lock releases.
  pi.on("input", async (event, ctx) => {
    if (activeUserWait) {
      const text = event.text.trim();
      if (text.length > 0) {
        activeUserWait.queuedPrompts.push(text);
        if (ctx.hasUI) {
          ctx.ui.setStatus("wait", formatUserWaitStatus(activeUserWait.names, activeUserWait.queuedPrompts.length));
          ctx.ui.notify(`Queued follow-up until /wait completes: ${previewText(text)}`, "info");
        }
      }
      return { action: "handled" as const };
    }

    if (waitAbortController) {
      waitAbortController.abort();
    }
    return { action: "continue" as const };
  });

  pi.on("agent_start", async (_event, ctx) => {
    const result = await runSemaphore(pi, ["agent-start"]);
    const text = resultText(result.stdout, result.stderr);
    if (result.code === 0) {
      const match = text.match(/Locked:\s+(.+)/);
      currentLockName = match?.[1]?.trim() || null;

      // Track context alert lock (created by tmux-coding-agent before pi started)
      if (contextAlertThreshold && currentLockName && !contextAlertLockName) {
        contextAlertLockName = `${currentLockName}:context`;
      }

      if (ctx.hasUI && currentLockName) {
        ctx.ui.setStatus("locks", `Locked: ${currentLockName}`);
      }
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.notify(text, "error");
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    await releaseContextAlertIfThresholdReached(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    // Check context alert before releasing the main lock
    await releaseContextAlertIfThresholdReached(ctx);

    // If the agent ended with a retryable error and we haven't exhausted retries,
    // hold the lock so semaphore_wait callers don't see a spurious release.
    // pi will auto-retry and fire agent_start → agent_end again.
    if (isRetryableError(event.messages)) {
      retryableErrorCount++;
      if (retryableErrorCount < MAX_RETRIES) {
        // Keep the lock held — retry is coming
        return;
      }
      // Max retries exhausted, fall through to release
    }

    retryableErrorCount = 0;

    const args = currentLockName ? ["agent-end", currentLockName] : ["agent-end"];
    const result = await runSemaphore(pi, args);
    if (result.code !== 0 && ctx.hasUI) {
      ctx.ui.notify(resultText(result.stdout, result.stderr), "error");
    }
    currentLockName = null;
    if (ctx.hasUI) {
      ctx.ui.setStatus("locks", undefined);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Clean up context alert lock if it was never released
    if (contextAlertLockName && !contextAlertReleased) {
      await runSemaphore(pi, ["release", contextAlertLockName]);
    }
    if (activeUserWait) {
      activeUserWait.abortController.abort();
      activeUserWait = null;
    }
    if (currentLockName) {
      await runSemaphore(pi, ["agent-end", currentLockName]);
    }
    currentLockName = null;
    if (ctx.hasUI) {
      ctx.ui.setStatus("locks", undefined);
      ctx.ui.setStatus("wait", undefined);
    }
  });

  pi.registerCommand("lock", {
    description: "Create a named lock in /tmp/pi-semaphores",
    handler: async (args, ctx) => {
      const names = parseNames(args);
      const result = await runSemaphore(pi, names.length > 0 ? ["lock", names[0]] : ["lock"]);
      if (ctx.hasUI) {
        ctx.ui.notify(resultText(result.stdout, result.stderr), result.code === 0 ? "info" : "warning");
      }
    },
  });

  pi.registerCommand("release", {
    description: "Release a named lock in /tmp/pi-semaphores",
    handler: async (args, ctx) => {
      const names = parseNames(args);
      const result = await runSemaphore(pi, names.length > 0 ? ["release", names[0]] : ["release"]);
      if (ctx.hasUI) {
        ctx.ui.notify(resultText(result.stdout, result.stderr), result.code === 0 ? "info" : "warning");
      }
    },
  });

  pi.registerCommand("wait", {
    description: "Wait for any of the named locks to be released",
    handler: async (args, ctx) => {
      const names = parseNames(args);
      if (names.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /wait <name> [name...]", "warning");
        }
        return;
      }
      if (activeUserWait) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Already waiting for: ${activeUserWait.names.join(", ")}`, "warning");
        }
        return;
      }

      const state: { names: string[]; queuedPrompts: string[]; abortController: AbortController } = {
        names,
        queuedPrompts: [],
        abortController: new AbortController(),
      };
      activeUserWait = state;
      if (ctx.hasUI) {
        ctx.ui.setStatus("wait", formatUserWaitStatus(names, 0));
        ctx.ui.notify(`Waiting for any lock: ${names.join(" ")}`, "info");
      }

      void (async () => {
        const result = await runSemaphore(pi, ["wait", ...names], state.abortController.signal);
        if (state.abortController.signal.aborted) {
          return;
        }
        const text = resultText(result.stdout, result.stderr);
        const queuedPrompts = [...state.queuedPrompts];
        if (activeUserWait === state) {
          activeUserWait = null;
        }
        if (ctx.hasUI) {
          ctx.ui.setStatus("wait", undefined);
          ctx.ui.notify(text, result.code === 0 ? "info" : "warning");
        }
        if (queuedPrompts.length > 0) {
          pi.sendUserMessage(combineQueuedPrompts(queuedPrompts));
        }
      })().catch((error: unknown) => {
        if (state.abortController.signal.aborted) {
          return;
        }
        if (activeUserWait === state) {
          activeUserWait = null;
        }
        if (ctx.hasUI) {
          ctx.ui.setStatus("wait", undefined);
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      });
    },
  });

  pi.registerCommand("lock-list", {
    description: "List locks in /tmp/pi-semaphores",
    handler: async (_args, ctx) => {
      const result = await runSemaphore(pi, ["list"]);
      if (!ctx.hasUI) {
        return;
      }
      const text = result.stdout.trim();
      ctx.ui.notify(text.length > 0 ? `Locks:\n${text}` : "No locks found.", "info");
    },
  });

  pi.registerTool({
    name: "semaphore_wait",
    label: "Wait for Locks",
    description:
      "Wait for one of many semaphore locks to be released. Use this to coordinate with other pi instances. " +
      "IMPORTANT: This call BLOCKS until a lock is released — you cannot do any other work while waiting. " +
      "Finish all independent tasks BEFORE calling this. " +
      "For agents spawned via tmux-coding-agent, wait on the lock name (e.g., 'worker').",
    parameters: semaphoreWaitSchema,
    async execute(_toolCallId, params, signal) {
      const { safeNames, timeoutSeconds } = getSemaphoreWaitParams(params);

      if (safeNames.length === 0) {
        throw new Error("No lock names provided.");
      }

      // For watch locks (<parent>:watch, <parent>:watch-N), automatically monitor
      // the parent lock too. If the parent releases before the watch pattern fires,
      // we report a warning instead of waiting forever on an orphaned watcher.
      const watchParentMap = new Map<string, string>(); // parent lock name -> watch lock name
      const parentNames: string[] = [];
      for (const name of safeNames) {
        const watchMatch = name.match(/^(.+?):watch(?:-\d+)?$/);
        if (watchMatch) {
          const parent = watchMatch[1];
          // Only add if the parent isn't already in the explicit wait list
          if (!safeNames.includes(parent)) {
            watchParentMap.set(parent, name);
            parentNames.push(parent);
          }
        }
      }
      const allNames = [...safeNames, ...parentNames];

      // Create a local abort controller so user input can interrupt the wait.
      // Combine with the tool's signal (abort on Escape) by forwarding it.
      const localAbort = new AbortController();
      waitAbortController = localAbort;

      const onToolAbort = () => localAbort.abort();
      if (signal) {
        if (signal.aborted) {
          localAbort.abort();
        } else {
          signal.addEventListener("abort", onToolAbort, { once: true });
        }
      }

      try {
        const result = await runSemaphore(
          pi,
          ["wait", "--timeout", String(timeoutSeconds), ...allNames],
          localAbort.signal,
        );
        const text = resultText(result.stdout, result.stderr);
        const found = result.code === 0;

        // If killed by user input, report interruption (not an error to the LLM)
        if (result.killed && localAbort.signal.aborted && !(signal?.aborted)) {
          return createSemaphoreWaitResult(
            safeNames,
            timeoutSeconds,
            "Wait interrupted by user message.",
            { names: safeNames, found: false, code: result.code, timeoutSeconds, interrupted: true },
          );
        }

        // Check if a parent lock released (rather than the watch lock itself).
        // cmd_wait outputs one of:
        //   "Lock released: <name>"         (polling loop)
        //   "Lock '<name>' already idle."   (early exit, process finished)
        //   "Lock '<name>' already released (not found)."  (early exit, gone)
        if (found && watchParentMap.size > 0) {
          let releasedParent: string | undefined;
          for (const parent of watchParentMap.keys()) {
            if (didParentLockRelease(text, parent)) {
              releasedParent = parent;
              break;
            }
          }
          if (releasedParent) {
            const watchName = watchParentMap.get(releasedParent)!;
            // Clean up the orphaned watch lock
            await runSemaphore(pi, ["release", watchName]);
            const warning =
              `⚠️ Parent lock '${releasedParent}' released while waiting for watch '${watchName}'. ` +
              `The watched process has stopped.`;
            return createSemaphoreWaitResult(
              safeNames,
              timeoutSeconds,
              warning,
              {
                names: safeNames,
                found: true,
                code: 0,
                timeoutSeconds,
                parentStopped: releasedParent,
                watchLock: watchName,
              },
            );
          }
        }

        const outputText = formatSemaphoreWaitText(safeNames, timeoutSeconds, text);

        if (result.code !== 0 && result.code !== 124) {
          throw new Error(outputText);
        }

        return {
          content: [{ type: "text", text: outputText }],
          details: { names: safeNames, found, code: result.code, timeoutSeconds } satisfies SemaphoreWaitDetails,
        };
      } finally {
        waitAbortController = null;
        if (signal) {
          signal.removeEventListener("abort", onToolAbort);
        }
      }
    },
  });
}

