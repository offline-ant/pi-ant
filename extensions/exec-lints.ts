/**
 * Execution-level lints and safety guards.
 *
 * Grep:
 * - local `grep`: always blocked — use the built-in grep tool instead.
 * - `grep` inside remote/nested quoted commands (for example `ssh host '... grep ...'`)
 *   and `grep` filtering `ssh` output are ignored because the built-in grep tool cannot replace them.
 *
 * Rust formatting:
 * - `cargo fmt`: blocked when invoked as a shell command — follow existing code style instead.
 * - `rustfmt`: blocked when invoked as a shell command — follow existing code style instead.
 *
 * Git safety:
 * - `git restore`: always blocked (other agents may have uncommitted work).
 * - `git checkout`: blocked on first attempt, allowed on retry (warn once).
 * - `git stash`: blocked on first attempt, allowed on retry (warn once).
 *
 * Pipe-tail lint:
 * - `| tail -<n>` at the end of a pipe decreases observability for the user
 *   — they can't scroll back to see the full output.
 * - In tmux-bash: the trailing `| tail …` is silently stripped and a warning
 *   is returned alongside the normal result.
 * - In bash: the command is blocked (once) with a message to use tmux-bash
 *   without the `| tail -<n>`.
 * - Only triggers when a preceding pipe segment contains 'build' or 'check'.
 *
 * Covers bash, tmux-bash, and tmux-send tool calls.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Patterns ────────────────────────────────────────────────────────────

const GIT_RESTORE_RE = /\bgit\s+restore\b/i;
const GIT_CHECKOUT_RE = /\bgit\s+checkout\b/i;
const GIT_STASH_RE = /\bgit\s+stash\b/i;
const CARGO_FMT_CMD_RE = /(?:^|[;&|\n]\s*)cargo\s+fmt\b/;
const RUSTFMT_CMD_RE = /(?:^|[;&|\n]\s*)rustfmt\b/;
const SHELL_COMMAND_SEPARATORS = new Set([";", "&", "&&", "||", "|", "\n", "("]);
const SHELL_COMMAND_START_KEYWORDS = new Set(["if", "then", "do", "else", "elif", "while", "until"]);

const GREP_NOTE =
  "Use the built-in `grep` tool instead of the bash `grep` command. " +
  "It's faster, respects .gitignore, and returns structured results.";

const RUSTFMT_NOTE =
  "Do not run `cargo fmt`/`rustfmt` — they create large diffs unrelated to the actual change. " +
  "Follow the existing code style in the file instead.";

const RESTORE_NOTE =
  "Other agents or the user may have uncommitted work. `git restore` is always blocked.";
const CHECKOUT_NOTE =
  "Other agents or the user may have uncommitted work. " +
  "Ask the user for permission, then retry the exact same command.";
const STASH_NOTE =
  "Other agents or the user may have uncommitted work. " +
  "Ask the user for permission, then retry the exact same command.";

// Matches `| tail -<n>` (with optional flags like -n, -f) as the last
// segment of a pipeline.  Handles `| tail -123`, `| tail -n 50`, etc.
const PIPE_TAIL_RE = /\|\s*tail\s+-[^\|]*$/;

// ── Helpers ─────────────────────────────────────────────────────────────

type TmuxBashInput = { name: string; command: string };
type TmuxSendInput = { name: string; text: string; enter?: boolean };
type BashInput = { command: string };
type ShellToken = { type: "word" | "operator"; text: string };
type ShellInvocation = { name: string; args: string[]; hasSshEarlierInPipeline: boolean };

/**
 * Extract the text to check from a tool call event.
 * Returns undefined for tool types we don't inspect.
 */
function extractCommand(event: { toolName: string; input: unknown }): string | undefined {
  if (event.toolName === "bash") return (event.input as Partial<BashInput> | undefined)?.command;
  if (event.toolName === "tmux-bash") return (event.input as Partial<TmuxBashInput> | undefined)?.command;
  if (event.toolName === "tmux-send") return (event.input as Partial<TmuxSendInput> | undefined)?.text;
  return undefined;
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;

  const pushWord = () => {
    if (word.length === 0) return;
    tokens.push({ type: "word", text: word });
    word = "";
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote) {
      if (char === "\\" && quote === '"' && i + 1 < command.length) {
        word += command[i + 1];
        i++;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        continue;
      }
      word += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\" && i + 1 < command.length) {
      word += command[i + 1];
      i++;
      continue;
    }

    if (char === "\n") {
      pushWord();
      tokens.push({ type: "operator", text: "\n" });
      continue;
    }

    if (/\s/.test(char)) {
      pushWord();
      continue;
    }

    if (char === "|" || char === "&") {
      pushWord();
      const next = command[i + 1];
      if (next === char) {
        tokens.push({ type: "operator", text: `${char}${next}` });
        i++;
      } else {
        tokens.push({ type: "operator", text: char });
      }
      continue;
    }

    if (char === ";" || char === "(" || char === ")") {
      pushWord();
      tokens.push({ type: "operator", text: char });
      continue;
    }

    word += char;
  }

  pushWord();
  return tokens;
}

function isAssignmentWord(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function getLocalShellInvocations(command: string): ShellInvocation[] {
  const invocations: ShellInvocation[] = [];
  let expectingCommand = true;
  let currentInvocation: ShellInvocation | undefined;
  let pipelineHasSsh = false;

  for (const token of tokenizeShell(command)) {
    if (token.type === "operator") {
      if (SHELL_COMMAND_SEPARATORS.has(token.text)) {
        expectingCommand = true;
        currentInvocation = undefined;
        if (token.text !== "|") pipelineHasSsh = false;
      }
      continue;
    }

    const word = token.text;
    if (SHELL_COMMAND_START_KEYWORDS.has(word)) {
      expectingCommand = true;
      currentInvocation = undefined;
      continue;
    }

    if (expectingCommand) {
      if (isAssignmentWord(word)) continue;
      currentInvocation = { name: word, args: [], hasSshEarlierInPipeline: pipelineHasSsh };
      invocations.push(currentInvocation);
      expectingCommand = false;
      if (commandBasename(word) === "ssh") pipelineHasSsh = true;
      continue;
    }

    currentInvocation?.args.push(word);
  }

  return invocations;
}

function commandBasename(command: string): string {
  const parts = command.split("/");
  return parts[parts.length - 1] ?? command;
}

function hasBlockedLocalGrep(command: string): boolean {
  return getLocalShellInvocations(command).some(
    (invocation) => commandBasename(invocation.name) === "grep" && !invocation.hasSshEarlierInPipeline,
  );
}

function blockRestore(toolName: string, command: string) {
  return {
    block: true,
    reason:
      `Blocked: \`git restore\` in ${toolName} command: ${command}. ${RESTORE_NOTE}`,
  };
}

function warnCheckout(toolName: string, command: string) {
  return {
    block: true,
    reason:
      `Blocked (first attempt): \`git checkout\` in ${toolName} command: ${command}. ${CHECKOUT_NOTE}`,
  };
}

function warnStash(toolName: string, command: string) {
  return {
    block: true,
    reason:
      `Blocked (first attempt): \`git stash\` in ${toolName} command: ${command}. ${STASH_NOTE}`,
  };
}

/**
 * Strip the trailing `| tail …` from a command string.
 */
function stripPipeTail(command: string): string {
  return command.replace(PIPE_TAIL_RE, "").trimEnd();
}

// ── Extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Track checkout commands that have been warned once.
  // Key: the exact command string. Cleared each turn so the agent
  // must re-earn permission for new checkout commands.
  const warnedCheckouts = new Set<string>();
  const warnedStashes = new Set<string>();
  let warnedBashPipeTail = false;
  let enabled = true;

  // ── Toggle command ──────────────────────────────────────────────────
  pi.registerCommand("exec-lints", {
    description: "Toggle exec-lints on/off (git restore/checkout/stash guards, pipe-tail lint)",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (ctx.hasUI) {
        ctx.ui.setStatus("exec-lints", enabled ? undefined : "exec-lints OFF");
      }
    },
  });

  // Reset at each new turn so stale approvals don't carry over.
  pi.on("turn_start", async () => {
    warnedCheckouts.clear();
    warnedStashes.clear();
    warnedBashPipeTail = false;
  });

  pi.on("tool_call", async (event) => {
    if (!enabled) return undefined;
    const command = extractCommand(event);
    if (command == null) return undefined;

    // grep command — block local bash invocations only, use grep tool instead
    if (event.toolName === "bash" && hasBlockedLocalGrep(command)) {
      return {
        block: true,
        reason:
          `Blocked: \`grep\` in bash command: ${command}. ${GREP_NOTE}`,
      };
    }

    // rust formatters — block shell-command invocations, not prose mentions
    if (CARGO_FMT_CMD_RE.test(command) || RUSTFMT_CMD_RE.test(command)) {
      return {
        block: true,
        reason:
          `Blocked: rust formatter in ${event.toolName} command: ${command}. ${RUSTFMT_NOTE}`,
      };
    }

    // git restore — always block
    if (GIT_RESTORE_RE.test(command)) {
      return blockRestore(event.toolName, command);
    }

    // git checkout — block first attempt, allow retry
    if (GIT_CHECKOUT_RE.test(command)) {
      if (warnedCheckouts.has(command)) {
        // Second attempt — let it through
        return undefined;
      }
      warnedCheckouts.add(command);
      return warnCheckout(event.toolName, command);
    }

    // git stash — block first attempt, allow retry
    if (GIT_STASH_RE.test(command)) {
      if (warnedStashes.has(command)) {
        // Second attempt — let it through
        return undefined;
      }
      warnedStashes.add(command);
      return warnStash(event.toolName, command);
    }

    // pipe tail lint — only when a preceding pipe segment contains 'build' or 'check'
    if (PIPE_TAIL_RE.test(command)) {
      const segments = command.split("|").slice(0, -1); // all segments before the tail
      if (segments.some((s) => s.includes("build") || s.includes("check"))) {
        if (event.toolName === "tmux-bash") {
          // Silently strip the trailing `| tail …`
          (event.input as TmuxBashInput).command = stripPipeTail(command);
          return undefined;
        }
        // bash / tmux-send: block first attempt, allow retry
        if (warnedBashPipeTail) return undefined;
        warnedBashPipeTail = true;
        return {
          block: true,
          reason:
            `Blocked: trailing \`| tail\` hides build output in ${event.toolName} command: ${command}. ` +
            `Re-run without the pipe tail: \`${stripPipeTail(command)}\``,
        };
      }
    }

    return undefined;
  });
}
