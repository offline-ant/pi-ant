/**
 * /worktree — create a sibling git worktree and switch pi into it.
 *
 * Usage: /worktree <name>
 *
 * Creates ../<repo-basename>-<name> from the current git repository. After the
 * worktree is created, forks the current session into the new worktree and
 * switches pi to that forked session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";

const WORKTREE_COMMAND_TIMEOUT_MS = 120_000;
const GIT_ROOT_TIMEOUT_MS = 10_000;
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateWorktreeName(name: string): string | undefined {
  if (!name) return "Usage: /worktree <name>";
  if (/\s/.test(name)) return "Worktree name must not contain whitespace";
  if (!WORKTREE_NAME_PATTERN.test(name)) {
    return "Worktree name must start with a letter or number and contain only letters, numbers, '.', '_', or '-'";
  }
  if (name === "." || name === ".." || name.includes("..")) {
    return "Worktree name must not be '.' or contain '..'";
  }
  return undefined;
}

function commandOutput(stdout: string, stderr: string): string {
  return (stderr.trim() || stdout.trim() || "command failed").split(/\r?\n/).slice(0, 8).join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function flushSessionFile(sessionManager: SessionManager, sessionFile: string): void {
  const header = sessionManager.getHeader();
  if (!header) {
    throw new Error("New session has no header");
  }

  const entries: Array<SessionHeader | SessionEntry> = [header, ...sessionManager.getEntries()];
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("worktree", {
    description: "Create ../<repo-basename>-<name> as a git worktree, fork the current session into it, and switch pi there. Usage: /worktree <name>",
    handler: async (args, ctx) => {
      const name = args.trim();
      const validationError = validateWorktreeName(name);
      if (validationError) {
        ctx.ui.notify(validationError, "error");
        return;
      }

      await ctx.waitForIdle();

      const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
        cwd: ctx.cwd,
        timeout: GIT_ROOT_TIMEOUT_MS,
      });
      if (rootResult.code !== 0) {
        ctx.ui.notify(`Not inside a git repository: ${commandOutput(rootResult.stdout, rootResult.stderr)}`, "error");
        return;
      }

      const gitRoot = rootResult.stdout.trim();
      if (!gitRoot) {
        ctx.ui.notify("git rev-parse returned an empty repository root", "error");
        return;
      }

      const parentDir = path.resolve(path.dirname(gitRoot));
      const targetPath = path.resolve(parentDir, `${path.basename(gitRoot)}-${name}`);
      if (path.dirname(targetPath) !== parentDir) {
        ctx.ui.notify("Resolved worktree path escaped the repository parent directory", "error");
        return;
      }
      if (fs.existsSync(targetPath)) {
        ctx.ui.notify(`Worktree path already exists: ${targetPath}`, "error");
        return;
      }

      ctx.ui.notify(`Creating worktree: ${targetPath}`, "info");
      const addResult = await pi.exec("git", ["worktree", "add", targetPath], {
        cwd: gitRoot,
        timeout: WORKTREE_COMMAND_TIMEOUT_MS,
      });
      if (addResult.code !== 0) {
        ctx.ui.notify(`git worktree add failed:\n${commandOutput(addResult.stdout, addResult.stderr)}`, "error");
        return;
      }

      const parentSession = ctx.sessionManager.getSessionFile();
      let sessionManager: SessionManager;
      try {
        sessionManager = parentSession && fs.existsSync(parentSession)
          ? SessionManager.forkFrom(parentSession, targetPath)
          : SessionManager.create(targetPath, undefined, { parentSession });
      } catch (error) {
        ctx.ui.notify(`Created worktree, but could not fork the current session into it: ${errorMessage(error)}`, "error");
        return;
      }

      const sessionFile = sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Created worktree, but could not create a persistent pi session for it", "error");
        return;
      }

      sessionManager.appendCustomEntry("worktree", {
        name,
        sourceCwd: ctx.cwd,
        sourceGitRoot: gitRoot,
        targetPath,
      });
      try {
        flushSessionFile(sessionManager, sessionFile);
      } catch (error) {
        ctx.ui.notify(`Created worktree, but could not persist the target session: ${errorMessage(error)}`, "error");
        return;
      }

      const switchResult = await ctx.switchSession(sessionFile, {
        withSession: async (newCtx) => {
          try {
            process.chdir(targetPath);
          } catch (error) {
            newCtx.ui.notify(`Switched session, but process chdir failed: ${errorMessage(error)}`, "warning");
            return;
          }
          newCtx.ui.notify(`Created worktree and switched to forked session: ${targetPath}`, "info");
        },
      });

      if (switchResult.cancelled) {
        ctx.ui.notify(`Created worktree, but session switch was cancelled: ${targetPath}`, "warning");
      }
    },
  });
}
