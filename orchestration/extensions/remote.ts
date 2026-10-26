import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyRemotePrompt, loadRemoteContext, REMOTE_SECTION, AGENTS_D_SECTION } from "../remote-context.ts";
import { formatRemoteLocation, REMOTE_ENV, sessionRemote } from "../remote-session.ts";
import { createRemoteToolDefinitions, remoteUserBashOperations } from "../remote-tools.ts";

const MARKER = "pi-orchestration:remote";
const STATUS_KEY = "remote";
/**
 * Pi does not expose its --no-context-files option to extensions. Clean workers
 * (fresh_look) pass it, and must not receive remote project instructions either.
 */
const CONTEXT_FILES_DISABLED = process.argv.includes("--no-context-files") || process.argv.includes("-nc");

/** The last remote target recorded on this branch; null when the branch last ran locally. */
function recordedRemote(ctx: ExtensionContext): string | null | undefined {
  const entry = ctx.sessionManager.getBranch().findLast((candidate) => candidate.type === "custom" && candidate.customType === MARKER);
  if (entry?.type !== "custom") return undefined;
  const target = (entry.data as { target?: unknown } | undefined)?.target;
  return typeof target === "string" ? target : null;
}

/**
 * Remote execution: when PI_REMOTE names an SSH target, the built-in file and
 * shell tools and `!` commands run there while Pi stays local. Children inherit
 * the target through the orchestration host environment.
 */
export default function remoteExtension(pi: ExtensionAPI): void {
  const remote = sessionRemote();

  pi.on("session_start", async (_event, ctx) => {
    const recorded = recordedRemote(ctx);
    if (!remote) {
      if (recorded) {
        ctx.ui.notify(`This session last ran its tools on ${recorded} over SSH; this process runs them locally. Restart it with ${REMOTE_ENV}=${recorded} to continue remotely.`, "warning");
      }
      return;
    }
    // grep spawns ripgrep locally even with custom operations.
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "grep"));
    const status = (color: "warning" | "accent" | "error", text: string) => {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text));
    };
    status("warning", `SSH ${remote.spec} (connecting)`);
    remote.location().then((location) => {
      const label = formatRemoteLocation(location);
      status("accent", `SSH ${label}`);
      if (recordedRemote(ctx) !== label) pi.appendEntry(MARKER, { target: label });
    }, (error: unknown) => {
      status("error", `SSH ${remote.spec} unavailable`);
      ctx.ui.notify(`Remote tools are unavailable: ${error instanceof Error ? error.message : String(error)}. Tools fail until the connection works; nothing runs locally instead.`, "error");
    });
  });

  if (!remote) return;

  for (const tool of createRemoteToolDefinitions(remote, process.cwd())) pi.registerTool(tool);

  pi.on("user_bash", () => ({ operations: remoteUserBashOperations(remote) }));

  pi.on("before_agent_start", async (event, ctx) => {
    const options = event.systemPromptOptions;
    try {
      const location = await remote.location(ctx.signal);
      const context = CONTEXT_FILES_DISABLED ? { contextFiles: [], agentsFiles: [], agentsEntries: [] } : await loadRemoteContext(location, ctx.signal);
      applyRemotePrompt(options, ctx.cwd, location, context);
    } catch (error) {
      // Never describe the local machine as the working environment.
      options.cwd = `${remote.spec} (unreachable)`;
      options.contextFiles = [];
      options.skills = [];
      delete options.sections[AGENTS_D_SECTION];
      options.sections[REMOTE_SECTION] = `Tools are configured to run on ${remote.spec} over SSH, but it is unavailable: ${error instanceof Error ? error.message : String(error)}\nTool calls fail until the connection works; nothing runs locally instead.`;
    }
  });
}
