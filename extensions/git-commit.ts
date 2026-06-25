/**
 * /git-commit — stage all git changes and commit them.
 *
 * Usage: /git-commit [message]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_COMMIT_MESSAGE = "auto";
const GIT_COMMAND_TIMEOUT_MS = 120_000;

function commandOutput(stdout: string, stderr: string): string {
  return (stderr.trim() || stdout.trim() || "command failed").split(/\r?\n/).slice(0, 12).join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git-commit", {
    description: "Run git add -A and git commit -m <message>. Defaults to message 'auto'. Usage: /git-commit [message]",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const message = args.trim() || DEFAULT_COMMIT_MESSAGE;
      const addResult = await pi.exec("git", ["add", "-A"], {
        cwd: ctx.cwd,
        timeout: GIT_COMMAND_TIMEOUT_MS,
      });
      if (addResult.code !== 0) {
        ctx.ui.notify(`git add -A failed:\n${commandOutput(addResult.stdout, addResult.stderr)}`, "error");
        return;
      }

      const commitResult = await pi.exec("git", ["commit", "-m", message], {
        cwd: ctx.cwd,
        timeout: GIT_COMMAND_TIMEOUT_MS,
      });
      const output = commandOutput(commitResult.stdout, commitResult.stderr);
      if (commitResult.code !== 0) {
        ctx.ui.notify(`git commit failed:\n${output}`, "error");
        return;
      }

      ctx.ui.notify(`Committed with message: ${message}\n${output}`, "info");
    },
  });
}
