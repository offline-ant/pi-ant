/**
 * Execution-level lints and safety guards.
 *
 * Grep:
 * - standalone local `grep`: blocked — use the built-in grep tool instead.
 * - `grep` used as a pipeline filter (`... | grep ...`) is allowed because the
 *   built-in grep tool cannot replace stdin filtering.
 * - `grep` inside remote/nested quoted commands (for example `ssh host '... grep ...'`)
 *   is ignored because the built-in grep tool cannot replace it.
 *
 * Git safety:
 * - `git restore`: always blocked (other agents may have uncommitted work).
 * - `git checkout`: blocked on first attempt, allowed on retry (warn once).
 * - `git stash`: blocked on first attempt, allowed on retry (warn once).
 *
 * Pipe-tail lint:
 * - local `| tail -<n>` at the end of a pipe decreases observability for the user
 *   — they can't scroll back to see the full output.
 * - `tail` inside remote/nested quoted commands and `tail` filtering `ssh` output
 *   are ignored because they may be needed to reduce remote output.
 * - Only triggers when the pipeline feeding `tail` builds, checks, or tests: a
 *   command named `build…`/`check…`/`test…`, or a `build`/`check`/`test` argument
 *   (also `build:prod` and similar script names).
 * - The command is blocked once (in bash, panel-start, and panel-send alike) and
 *   never rewritten; the suggested retry drops only the `| tail …` segment and
 *   keeps its redirections, so `cmd | tail -5 > log` suggests `cmd > log`.
 *
 * Sleep lint:
 * - a local `sleep` of 2 seconds or more, or any `sleep` inside a shell loop
 *   (polling), in bash or panel-send: always blocked. Agents should react when
 *   something is ready with the `wait` tool instead of guessing a duration.
 * - Scripts of local `bash|sh|dash|zsh|fish -c '…'`, also behind wrappers such as
 *   `timeout 300`, `env X=1`, or `nice -n 5`, are checked by the same rules.
 * - `sleep` after `ssh` and in panel-start commands (servers and watchers may
 *   legitimately pace themselves) is ignored.
 *
 * Covers bash, panel-start, and panel-send tool calls.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Patterns ────────────────────────────────────────────────────────────

const GIT_RESTORE_RE = /\bgit\s+restore\b/i;
const GIT_CHECKOUT_RE = /\bgit\s+checkout\b/i;
const GIT_STASH_RE = /\bgit\s+stash\b/i;
const SHELL_COMMAND_SEPARATORS = new Set([";", "&", "&&", "||", "|", "\n", "("]);
const SHELL_COMMAND_START_KEYWORDS = new Set(["if", "then", "do", "else", "elif", "while", "until"]);

const GREP_NOTE =
  "Use the built-in `grep` tool instead of the bash `grep` command. " +
  "It's faster, respects .gitignore, and returns structured results.";

const SLEEP_NOTE =
  "Do not sleep to wait for builds, servers, panels, or processes. Use the `wait` tool, which returns as soon as " +
  "something is ready: wait({panel, match?, timeoutSeconds}) for panel output, its shell prompt, or exit; " +
  "wait({file, match, timeoutSeconds}) for a log line; wait({pid, timeoutSeconds}) for a process. " +
  "Start long-running commands with panel-start, or run them in bash with output to a log file.";
const SLEEP_LIMIT_SECONDS = 2;
const SLEEP_UNITS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

const RESTORE_NOTE =
  "Other agents or the user may have uncommitted work. `git restore` is always blocked.";
const CHECKOUT_NOTE =
  "Other agents or the user may have uncommitted work. " +
  "Ask the user for permission, then retry the exact same command.";
const STASH_NOTE =
  "Other agents or the user may have uncommitted work. " +
  "Ask the user for permission, then retry the exact same command.";

/** Commands and arguments whose output a trailing `| tail` would hide. */
const BUILD_COMMAND_RE = /^(?:build|check|test)/;
const BUILD_ARG_RE = /^(?:build|check|test)(?::\S*)?$/;

/** A redirection word; an empty last group means its target is the next word. */
const REDIRECTION_RE = /^(?:\d+|&)?(?:>&|<&|>>|>\||<<<|<<|>|<)(.*)$/;
/** Commands that run their arguments as another command. */
const COMMAND_WRAPPERS = new Set(["command", "env", "exec", "nice", "nohup", "setsid", "stdbuf", "sudo", "time", "timeout"]);
const WRAPPER_DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;
const SHELLS = new Set(["bash", "dash", "fish", "sh", "zsh"]);

// ── Helpers ─────────────────────────────────────────────────────────────

type PanelStartInput = { name: string; command: string };
type PanelSendInput = { name: string; text?: string; keys?: string[] };
type BashInput = { command: string };
type ShellToken = {
  type: "word" | "operator";
  /** Text with quotes and escapes removed. */
  text: string;
  start: number;
  end: number;
  /** Starts with a quote or escape, so it is literal text rather than a redirection. */
  literalStart: boolean;
};
type ShellInvocation = {
  name: string;
  /** Arguments, without redirections. */
  args: string[];
  redirections: ShellToken[];
  /** Name, argument, and redirection words in order. */
  words: ShellToken[];
  /** Start of the `|` feeding this command, when it is not first in its pipeline. */
  pipeStart?: number;
  hasSshEarlierInPipeline: boolean;
  /** Inside the body or condition of a while, until, or for loop. */
  inLoop: boolean;
};

/**
 * Extract the text to check from a tool call event.
 * Returns undefined for tool types we don't inspect.
 */
function extractCommand(event: { toolName: string; input: unknown }): string | undefined {
  if (event.toolName === "bash") return (event.input as Partial<BashInput> | undefined)?.command;
  if (event.toolName === "panel-start") return (event.input as Partial<PanelStartInput> | undefined)?.command;
  if (event.toolName === "panel-send") return (event.input as Partial<PanelSendInput> | undefined)?.text;
  return undefined;
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = "";
  let wordStart: number | undefined;
  let literalStart = false;
  let quote: "'" | '"' | undefined;

  const appendWordChar = (char: string, index: number) => {
    wordStart ??= index;
    word += char;
  };

  const pushWord = (end: number) => {
    if (word.length > 0) tokens.push({ type: "word", text: word, start: wordStart ?? 0, end, literalStart });
    word = "";
    wordStart = undefined;
    literalStart = false;
  };
  const pushOperator = (text: string, start: number) => {
    tokens.push({ type: "operator", text, start, end: start + text.length, literalStart: false });
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote) {
      if (char === "\\" && quote === '"' && i + 1 < command.length) {
        appendWordChar(command[i + 1], i);
        i++;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        continue;
      }
      appendWordChar(char, i);
      continue;
    }

    if (char === "'" || char === '"') {
      if (wordStart === undefined) literalStart = true;
      wordStart ??= i;
      quote = char;
      continue;
    }

    if (char === "\\" && i + 1 < command.length) {
      if (wordStart === undefined) literalStart = true;
      appendWordChar(command[i + 1], i);
      i++;
      continue;
    }

    if (char === "\n") {
      pushWord(i);
      pushOperator("\n", i);
      continue;
    }

    if (/\s/.test(char)) {
      pushWord(i);
      continue;
    }

    // `&` within a redirection (`2>&1`, `>&2`, `&>log`) is part of that word.
    if (char === "&" && (/[<>]$/.test(word) || command[i + 1] === ">")) {
      appendWordChar(char, i);
      continue;
    }

    if (char === "|" || char === "&") {
      pushWord(i);
      const next = command[i + 1];
      if (next === char) {
        pushOperator(`${char}${next}`, i);
        i++;
      } else {
        pushOperator(char, i);
      }
      continue;
    }

    if (char === ";" || char === "(" || char === ")") {
      pushWord(i);
      pushOperator(char, i);
      continue;
    }

    appendWordChar(char, i);
  }

  pushWord(command.length);
  return tokens;
}

function isAssignmentWord(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function getLocalShellInvocations(command: string): ShellInvocation[] {
  const invocations: ShellInvocation[] = [];
  let expectingCommand = true;
  let currentInvocation: ShellInvocation | undefined;
  let pipeStart: number | undefined;
  let pipelineHasSsh = false;
  let loopDepth = 0;
  let redirectionTargetPending = false;

  for (const token of tokenizeShell(command)) {
    if (token.type === "operator") {
      redirectionTargetPending = false;
      if (token.text === "|") {
        expectingCommand = true;
        currentInvocation = undefined;
        pipeStart = token.start;
        continue;
      }
      if (SHELL_COMMAND_SEPARATORS.has(token.text)) {
        expectingCommand = true;
        currentInvocation = undefined;
        pipeStart = undefined;
        pipelineHasSsh = false;
      }
      continue;
    }

    const word = token.text;
    if (SHELL_COMMAND_START_KEYWORDS.has(word)) {
      if (expectingCommand && (word === "while" || word === "until")) loopDepth++;
      expectingCommand = true;
      currentInvocation = undefined;
      continue;
    }

    if (expectingCommand) {
      if (isAssignmentWord(word)) continue;
      if (word === "done") {
        loopDepth = Math.max(0, loopDepth - 1);
        expectingCommand = false;
        continue;
      }
      if (word === "for") {
        // `for name in words` lists no commands; its body follows `do`.
        loopDepth++;
        currentInvocation = undefined;
        expectingCommand = false;
        continue;
      }
      currentInvocation = {
        name: word,
        args: [],
        redirections: [],
        words: [token],
        ...(pipeStart !== undefined ? { pipeStart } : {}),
        hasSshEarlierInPipeline: pipelineHasSsh,
        inLoop: loopDepth > 0,
      };
      invocations.push(currentInvocation);
      expectingCommand = false;
      if (commandBasename(word) === "ssh") pipelineHasSsh = true;
      continue;
    }

    if (!currentInvocation) continue;
    currentInvocation.words.push(token);
    const redirection = token.literalStart ? undefined : REDIRECTION_RE.exec(word);
    if (redirectionTargetPending || redirection) {
      currentInvocation.redirections.push(token);
      redirectionTargetPending = !redirectionTargetPending && redirection?.[1] === "";
    } else {
      currentInvocation.args.push(word);
    }
  }

  return invocations;
}

function commandBasename(command: string): string {
  const parts = command.split("/");
  return parts[parts.length - 1] ?? command;
}

function hasBlockedLocalGrep(command: string): boolean {
  return getLocalShellInvocations(command).some(
    (invocation) =>
      commandBasename(invocation.name) === "grep" &&
      invocation.pipeStart === undefined &&
      !invocation.hasSshEarlierInPipeline,
  );
}

/** Total duration of `sleep` arguments, or undefined when it cannot be determined statically. */
function sleepSeconds(args: string[]): number | undefined {
  let total = 0;
  for (const arg of args) {
    const match = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(arg);
    if (!match) return undefined;
    total += Number(match[1]) * SLEEP_UNITS[match[2]];
  }
  return total;
}

/** The script of a shell run as `<shell> -c <script>`, possibly behind wrappers such as `timeout 300` or `env X=1`. */
function shellScript(invocation: ShellInvocation): string | undefined {
  const words = [invocation.name, ...invocation.args];
  let index = 0;
  while (COMMAND_WRAPPERS.has(commandBasename(words[index] ?? ""))) {
    index++;
    while (index < words.length && (words[index].startsWith("-") || isAssignmentWord(words[index]) || WRAPPER_DURATION_RE.test(words[index]))) index++;
  }
  if (!SHELLS.has(commandBasename(words[index] ?? ""))) return undefined;
  let command = false;
  for (const word of words.slice(index + 1)) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) command = true;
    else if (!word.startsWith("-")) return command ? word : undefined;
  }
  return undefined;
}

function hasBlockedSleep(command: string, inLoop = false): boolean {
  return getLocalShellInvocations(command).some((invocation) => {
    if (invocation.hasSshEarlierInPipeline) return false;
    const looping = inLoop || invocation.inLoop;
    const script = shellScript(invocation);
    if (script !== undefined) return hasBlockedSleep(script, looping);
    if (commandBasename(invocation.name) !== "sleep") return false;
    if (looping) return true;
    const seconds = sleepSeconds(invocation.args);
    return seconds === undefined || seconds >= SLEEP_LIMIT_SECONDS;
  });
}

/** A trailing local `| tail -<n>` hiding the output of a build, check, or test pipeline. */
function getBlockedLocalPipeTail(command: string): ShellInvocation | undefined {
  const invocations = getLocalShellInvocations(command);
  const tail = invocations.at(-1);
  if (!tail || commandBasename(tail.name) !== "tail" || tail.pipeStart === undefined || tail.hasSshEarlierInPipeline) return undefined;
  if (!tail.args.some((arg) => arg.startsWith("-"))) return undefined;

  let first = invocations.length - 1;
  while (first > 0 && invocations[first].pipeStart !== undefined) first--;
  const feeding = invocations.slice(first, -1);
  const builds = feeding.some((invocation) =>
    BUILD_COMMAND_RE.test(commandBasename(invocation.name)) || invocation.args.some((arg) => BUILD_ARG_RE.test(arg)));
  return builds ? tail : undefined;
}

/** `command` without its trailing `| tail …` segment, keeping the tail's redirections. */
function withoutPipeTail(command: string, tail: ShellInvocation): string {
  return [
    command.slice(0, tail.pipeStart).trimEnd(),
    ...tail.redirections.map((token) => command.slice(token.start, token.end)),
    command.slice(tail.words.at(-1)!.end).trim(),
  ].filter(Boolean).join(" ");
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

// ── Extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Track checkout commands that have been warned once.
  // Key: the exact command string. Cleared each turn so the agent
  // must re-earn permission for new checkout commands.
  const warnedCheckouts = new Set<string>();
  const warnedStashes = new Set<string>();
  let warnedPipeTail = false;
  let enabled = true;

  // ── Toggle command ──────────────────────────────────────────────────
  pi.registerCommand("exec-lints", {
    description: "Toggle exec-lints on/off (git restore/checkout/stash guards, pipe-tail and sleep lints)",
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
    warnedPipeTail = false;
  });

  pi.on("tool_call", async (event) => {
    if (!enabled) return undefined;
    const command = extractCommand(event);
    if (command == null) return undefined;

    // grep command — block standalone local bash invocations only, use grep tool instead
    if (event.toolName === "bash" && hasBlockedLocalGrep(command)) {
      return {
        block: true,
        reason:
          `Blocked: \`grep\` in bash command: ${command}. ${GREP_NOTE}`,
      };
    }

    // sleep — always block in commands the agent waits on; panel-start commands run on their own.
    if (event.toolName !== "panel-start" && hasBlockedSleep(command)) {
      return {
        block: true,
        reason: `Blocked: \`sleep\` in ${event.toolName} command: ${command}. ${SLEEP_NOTE}`,
      };
    }

    // Optional Rust formatter lint. Uncomment to re-enable.
    /*
    if (
      /(?:^|[;&|\n]\s*)cargo\s+fmt\b/.test(command) ||
      /(?:^|[;&|\n]\s*)rustfmt\b/.test(command)
    ) {
      return {
        block: true,
        reason:
          `Blocked: rust formatter in ${event.toolName} command: ${command}. ` +
          "Do not run `cargo fmt`/`rustfmt` — they create large diffs unrelated to the actual change. " +
          "Follow the existing code style in the file instead.",
      };
    }
    */

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

    // pipe tail lint — block the first attempt, allow a retry
    const tail = getBlockedLocalPipeTail(command);
    if (tail && !warnedPipeTail) {
      warnedPipeTail = true;
      return {
        block: true,
        reason:
          `Blocked: trailing \`| tail\` hides build output in ${event.toolName} command: ${command}. ` +
          `Re-run without the pipe tail: \`${withoutPipeTail(command, tail)}\``,
      };
    }

    return undefined;
  });
}
