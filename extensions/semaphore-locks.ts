/**
 * Semaphore Locks Extension (script-backed)
 *
 * Delegates lock operations to ../bin/pi-semaphore.
 */

import * as path from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const SEMAPHORE_SCRIPT = path.resolve(__dirname, "../bin/pi-semaphore");
const TMUX_SCRIPT = path.resolve(__dirname, "../bin/pi-tmux");

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

async function runTmux(
  pi: ExtensionAPI,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
  return pi.exec("bash", [TMUX_SCRIPT, ...args], { signal });
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

function parseLockedName(text: string): string | null {
  const match = text.match(/Locked:\s+(.+)/);
  return match?.[1]?.trim() || null;
}

function defaultWaitLockName(): string {
  const envName = sanitizeName(process.env.PI_LOCK_NAME ?? "");
  const base = envName || sanitizeName(path.basename(process.cwd() || ".")) || "session";
  return `${base}:wait`;
}

const MAX_RETRIES = 3;
const DEFAULT_SEMAPHORE_WAIT_TIMEOUT_SECONDS = 600;
const SEMAPHORE_WAIT_CAPTURE_INTERVAL_MS = 5000;
const SEMAPHORE_WAIT_CAPTURE_LINES = 8;

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
  childLock?: string;
  watchLock?: string;
}

interface ActiveUserWaitState {
  names: string[];
  queuedPrompts: string[];
  abortController: AbortController;
  waitLockName: string | null;
  waitLockOwned: boolean;
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

function getCaptureTarget(lockName: string): string {
  const childMatch = lockName.match(/^(.+?):(?:watch(?:-\d+)?|context)$/);
  return childMatch?.[1] ?? lockName;
}

function getCaptureRequests(names: string[]): Array<{ target: string; labels: string[] }> {
  const labelsByTarget = new Map<string, string[]>();
  for (const name of names) {
    const target = getCaptureTarget(name);
    const labels = labelsByTarget.get(target) ?? [];
    labels.push(name);
    labelsByTarget.set(target, labels);
  }

  return [...labelsByTarget.entries()].map(([target, labels]) => ({ target, labels }));
}

function formatCaptureLabel(target: string, labels: string[]): string {
  if (labels.length === 1 && labels[0] === target) {
    return target;
  }
  return `${target} (${labels.join(", ")})`;
}

async function buildSemaphoreWaitProgressText(
  pi: ExtensionAPI,
  names: string[],
  timeoutSeconds: number,
  startedAt: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const timeoutText = timeoutSeconds > 0 ? `, timeout ${timeoutSeconds}s` : "";
  const sections: string[] = [];

  for (const request of getCaptureRequests(names)) {
    if (signal?.aborted) {
      return undefined;
    }

    try {
      const result = await runTmux(
        pi,
        ["capture", request.target, String(SEMAPHORE_WAIT_CAPTURE_LINES)],
        signal,
      );
      if (result.code !== 0 || result.killed) {
        continue;
      }

      const output = result.stdout.trimEnd();
      if (output.trim().length === 0) {
        continue;
      }

      const label = formatCaptureLabel(request.target, request.labels);
      const frame = `--- ${label}: last ${SEMAPHORE_WAIT_CAPTURE_LINES} semaphore peek lines ---`;
      sections.push(`${frame}\n${output}\n${frame}`);
    } catch (_error) {
      if (signal?.aborted) {
        return undefined;
      }
    }
  }

  return [
    `Waiting for ${names.join(", ")} (${elapsedSeconds}s elapsed${timeoutText})`,
    sections.length > 0 ? sections.join("\n\n") : "(semaphore peek unavailable)",
  ].join("\n\n");
}

function startSemaphoreWaitProgressUpdates(
  pi: ExtensionAPI,
  names: string[],
  timeoutSeconds: number,
  isPollingEnabled: () => boolean,
  onUpdate: AgentToolUpdateCallback<SemaphoreWaitDetails> | undefined,
  signal?: AbortSignal,
): () => void {
  if (!onUpdate) {
    return () => {};
  }

  const startedAt = Date.now();
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const update = () => {
    if (stopped || inFlight || !isPollingEnabled()) {
      return;
    }
    inFlight = true;
    void (async () => {
      try {
        const text = await buildSemaphoreWaitProgressText(pi, names, timeoutSeconds, startedAt, signal);
        if (!stopped && text !== undefined) {
          onUpdate({
            content: [{ type: "text", text }],
            details: { names, found: false, code: -1, timeoutSeconds },
          });
        }
      } finally {
        inFlight = false;
      }
    })();
  };

  if (signal) {
    if (signal.aborted) {
      return stop;
    }
    signal.addEventListener("abort", stop, { once: true });
  }

  update();
  timer = setInterval(update, SEMAPHORE_WAIT_CAPTURE_INTERVAL_MS);

  return () => {
    stop();
    signal?.removeEventListener("abort", stop);
  };
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
  let semaphoreWaitPollingEnabled = true;

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

  let activeUserWait: ActiveUserWaitState | null = null;

  async function releaseOwnedWaitLock(ctx: ExtensionContext, state: ActiveUserWaitState): Promise<void> {
    if (!state.waitLockOwned || !state.waitLockName || currentLockName !== state.waitLockName) {
      return;
    }

    const result = await runSemaphore(pi, ["agent-end", state.waitLockName]);
    if (result.code !== 0 && ctx.hasUI) {
      ctx.ui.notify(resultText(result.stdout, result.stderr), "error");
    }
    currentLockName = null;
    if (ctx.hasUI) {
      ctx.ui.setStatus("locks", undefined);
    }
  }

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
    const result = await runSemaphore(pi, currentLockName ? ["agent-start", currentLockName] : ["agent-start"]);
    const text = resultText(result.stdout, result.stderr);
    if (result.code === 0) {
      currentLockName = parseLockedName(text);

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

      const hadLock = currentLockName !== null;
      let waitLockName = currentLockName;
      let waitLockOwned = false;
      if (!waitLockName) {
        const lockResult = await runSemaphore(pi, ["agent-start", defaultWaitLockName()]);
        const lockText = resultText(lockResult.stdout, lockResult.stderr);
        if (lockResult.code === 0) {
          waitLockName = parseLockedName(lockText);
          currentLockName = waitLockName;
          waitLockOwned = waitLockName !== null;
        } else if (ctx.hasUI) {
          ctx.ui.notify(lockText, "warning");
        }
      }

      const state: ActiveUserWaitState = {
        names,
        queuedPrompts: [],
        abortController: new AbortController(),
        waitLockName,
        waitLockOwned: !hadLock && waitLockOwned,
      };
      activeUserWait = state;
      if (ctx.hasUI) {
        if (waitLockName) {
          ctx.ui.setStatus("locks", `Locked: ${waitLockName}`);
        }
        ctx.ui.setStatus("wait", formatUserWaitStatus(names, 0));
        ctx.ui.notify(`Waiting for any lock: ${names.join(" ")}`, "info");
      }

      void (async () => {
        const result = await runSemaphore(pi, ["wait", "--timeout", "0", ...names], state.abortController.signal);
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
        } else {
          await releaseOwnedWaitLock(ctx, state);
        }
      })().catch(async (error: unknown) => {
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
        await releaseOwnedWaitLock(ctx, state);
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

  const pollSemaphoreWaitHandler = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const value = args.trim().toLowerCase();
    if (value.length === 0 || value === "toggle") {
      semaphoreWaitPollingEnabled = !semaphoreWaitPollingEnabled;
    } else if (["on", "enable", "enabled", "true", "1"].includes(value)) {
      semaphoreWaitPollingEnabled = true;
    } else if (["off", "disable", "disabled", "false", "0"].includes(value)) {
      semaphoreWaitPollingEnabled = false;
    } else if (value !== "status") {
      if (ctx.hasUI) {
        ctx.ui.notify("Usage: /poll-semaphore_wait [on|off|toggle|status]", "warning");
      }
      return;
    }

    if (ctx.hasUI) {
      ctx.ui.notify(`semaphore_wait polling ${semaphoreWaitPollingEnabled ? "enabled" : "disabled"}.`, "info");
    }
  };

  pi.registerCommand("poll-semaphore_wait", {
    description: "Toggle semaphore_wait progress polling",
    handler: pollSemaphoreWaitHandler,
  });

  pi.registerCommand("poll-sempahore_wait", {
    description: "Toggle semaphore_wait progress polling",
    handler: pollSemaphoreWaitHandler,
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
    async execute(_toolCallId, params, signal, onUpdate) {
      const { safeNames, timeoutSeconds } = getSemaphoreWaitParams(params);

      if (safeNames.length === 0) {
        throw new Error("No lock names provided.");
      }

      // For child locks (<parent>:watch, <parent>:watch-N, <parent>:context),
      // automatically monitor the parent lock too. If the parent releases before
      // the child lock fires, report a warning instead of waiting forever on an
      // orphaned child lock.
      const childParentMap = new Map<string, string>(); // parent lock name -> child lock name
      const parentNames: string[] = [];
      for (const name of safeNames) {
        const childMatch = name.match(/^(.+?):(?:watch(?:-\d+)?|context)$/);
        if (childMatch) {
          const parent = childMatch[1];
          // Only add if the parent isn't already in the explicit wait list
          if (!safeNames.includes(parent)) {
            childParentMap.set(parent, name);
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

      const stopProgressUpdates = startSemaphoreWaitProgressUpdates(
        pi,
        safeNames,
        timeoutSeconds,
        () => semaphoreWaitPollingEnabled,
        onUpdate,
        localAbort.signal,
      );

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

        // Check if a parent lock released (rather than the child lock itself).
        // cmd_wait outputs one of:
        //   "Lock released: <name>"         (polling loop)
        //   "Lock '<name>' already idle."   (early exit, process finished)
        //   "Lock '<name>' already released (not found)."  (early exit, gone)
        if (found && childParentMap.size > 0) {
          let releasedParent: string | undefined;
          for (const parent of childParentMap.keys()) {
            if (didParentLockRelease(text, parent)) {
              releasedParent = parent;
              break;
            }
          }
          if (releasedParent) {
            const childName = childParentMap.get(releasedParent)!;
            // Clean up the orphaned child lock
            await runSemaphore(pi, ["release", childName]);
            const warning =
              `⚠️ Parent lock '${releasedParent}' released while waiting for '${childName}'. ` +
              `The monitored process has stopped.`;
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
                childLock: childName,
                watchLock: childName.includes(":watch") ? childName : undefined,
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
        stopProgressUpdates();
        waitAbortController = null;
        if (signal) {
          signal.removeEventListener("abort", onToolAbort);
        }
      }
    },
  });
}

