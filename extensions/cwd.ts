/**
 * /cwd — change pi's working directory without starting a new session.
 *
 * Usage: /cwd <path>
 *
 * Rewrites the current session header to the target cwd, reloads the same
 * session file through pi's normal session-switch path, and updates the Node
 * process cwd so subsequent relative filesystem operations use the same base.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, SessionEntry, SessionHeader, SessionManager } from "@earendil-works/pi-coding-agent";

type SessionSnapshot = Pick<SessionManager, "getEntries" | "getHeader">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveTargetCwd(input: string, currentCwd: string): string {
  return path.resolve(currentCwd, expandHome(input));
}

function validateTargetCwd(targetCwd: string): string | undefined {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(targetCwd);
  } catch (error) {
    return `Directory does not exist: ${targetCwd}\n${errorMessage(error)}`;
  }

  if (!stats.isDirectory()) {
    return `Not a directory: ${targetCwd}`;
  }
  return undefined;
}

function writeSessionWithCwd(sessionManager: SessionSnapshot, sessionFile: string, cwd: string): void {
  const header = sessionManager.getHeader();
  if (!header) {
    throw new Error("Current session has no header");
  }

  const updatedHeader: SessionHeader = { ...header, cwd };
  const entries: Array<SessionHeader | SessionEntry> = [updatedHeader, ...sessionManager.getEntries()];
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cwd", {
    description: "Change pi's working directory without starting a new session. Usage: /cwd <path>",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify(`Current cwd: ${ctx.cwd}`, "info");
        return;
      }

      const targetCwd = resolveTargetCwd(input, ctx.cwd);
      const validationError = validateTargetCwd(targetCwd);
      if (validationError) {
        ctx.ui.notify(validationError, "error");
        return;
      }

      if (targetCwd === path.resolve(ctx.cwd)) {
        ctx.ui.notify(`Already in cwd: ${targetCwd}`, "info");
        return;
      }

      await ctx.waitForIdle();

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("/cwd requires a persistent session; the current session has no session file", "error");
        return;
      }

      const sessionFileExisted = fs.existsSync(sessionFile);
      const originalSessionFile = sessionFileExisted ? fs.readFileSync(sessionFile, "utf8") : undefined;

      try {
        writeSessionWithCwd(ctx.sessionManager, sessionFile, targetCwd);
      } catch (error) {
        ctx.ui.notify(`Could not update the current session cwd: ${errorMessage(error)}`, "error");
        return;
      }

      const switchResult = await ctx.switchSession(sessionFile, {
        withSession: async (newCtx) => {
          try {
            process.chdir(targetCwd);
          } catch (error) {
            newCtx.ui.notify(`Changed pi cwd, but process chdir failed: ${errorMessage(error)}`, "warning");
            return;
          }
          newCtx.ui.notify(`Changed cwd: ${targetCwd}`, "info");
        },
      });

      if (switchResult.cancelled) {
        try {
          if (originalSessionFile !== undefined) {
            fs.writeFileSync(sessionFile, originalSessionFile, "utf8");
          } else {
            fs.rmSync(sessionFile, { force: true });
          }
        } catch (error) {
          ctx.ui.notify(`cwd change was cancelled, but rollback failed: ${errorMessage(error)}`, "warning");
          return;
        }
        ctx.ui.notify(`cwd change cancelled; stayed in ${ctx.cwd}`, "warning");
      }
    },
  });
}
