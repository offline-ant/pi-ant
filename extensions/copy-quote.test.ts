import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import copyQuoteExtension, { copyQuote } from "./copy-quote/index.ts";
import { extractQuotes } from "./copy-quote/markdown.ts";

const cases: Array<[string, string, string[]]> = [
  ["document BOM does not shift source offsets", "\uFEFF> text", ["text"]],
  ["source Markdown and hard breaks", "> **Bold** and [link](https://example.com)  \n> next\n>\n> - item\n>   continuation", ["**Bold** and [link](https://example.com)  \nnext\n\n- item\n  continuation"]],
  ["multiple quotes", "> first\n\nOutside.\n\n> second", ["first", "second"]],
  ["nested quotes are one choice", "> outer\n>\n> > inner\n> >> deepest\n>\n> end", ["outer\n\ninner\ndeepest\n\nend"]],
  ["fences inside and outside quotes", "```md\n> not a quote\n```\n\n> ```sh\n> > literal | pipe\n> ```\n>\n> ~~~text\n> >> still literal\n> ~~~", ["```sh\n> literal | pipe\n```\n\n~~~text\n>> still literal\n~~~"]],
  ["literal greater-than and pipes", "> a > b | c │ d\n> `> code` and \\> escaped\n>\n>     > indented code |", ["a > b | c │ d\n`> code` and \\> escaped\n\n    > indented code |"]],
  ["non-quotes", "`> inline`\n\n\\> escaped\n\n    > code\n\n<pre>\n> html\n</pre>", []],
  ["HTML inside a quote", "> <pre>\n> > literal\n> </pre>", ["<pre>\n> literal\n</pre>"]],
  ["lazy continuation and nested restated marker", "> > first\nlazy\n> > last", ["first\nlazy\nlast"]],
  ["lazy setext line preserved", "> first\n===", ["first\n==="]],
  ["duplicate definitions preserved", "> [x]: /one\n> [x]: /two\n>\n> > nested", ["[x]: /one\n[x]: /two\n\nnested"]],
  ["quotes inside lists", "- > one\n  > two\n\n- plain\n\n1. > three", ["one\ntwo", "three"]],
  ["lists inside quotes containing quotes", "> - item\n>\n>   > inner\n>   > next\n>\n> - [x] task\n>\n>   > another", ["- item\n\n  inner\n  next\n\n- [x] task\n\n  another"]],
  ["tabs inside nested lists and code", "> - item\n>\n> \t> inner > literal\n> \t> ```\n> \t> a\tb > c\n> \t> ```", ["- item\n\n\tinner > literal\n\t```\n\ta\tb > c\n\t```"]],
  ["task text is not reinterpreted as a quote", "> - [x] > literal", ["- [x] > literal"]],
  ["task text outside quotes", "- [x] > literal", []],
  ["code tabs in a list-contained quote", "- > ```\n  > a\tb\n  > ```", ["```\na\tb\n```"]],
  ["partly consumed delimiter tab retains code indentation", ">\t  code", ["    code"]],
  ["partly consumed tab in fenced code", "> ```\n>\t  code\n> ```", ["```\n    code\n```"]],
  ["tab whitespace consumed by nested quotation", ">\t> text", ["text"]],
  ["external and internal lists", "- > - item\n  >   continuation\n  >\n  >   > nested", ["- item\n  continuation\n\n  nested"]],
  ["optional quote indentation", "  > a\n   > b", ["a\nb"]],
  ["nested lazy list continuation", "> - first\n>   > nested\nlazy", ["- first\n  nested\nlazy"]],
  ["lazy list continuation without a final newline", "> - item\nlazy", ["- item\nlazy"]],
  ["loose task list with nested quote", "> - [x] task\n>\n>   > nested\n>\n> - other", ["- [x] task\n\n  nested\n\n- other"]],
  ["blank quotes and preserved source line endings", ">\n\ntext\n\n> a\r\n> b\r\n", ["a\r\nb"]],
  ["blank lines and trailing spaces", ">\n> a  \n>\n> b\n>", ["\na  \n\nb\n"]],
];
for (const [name, source, expected] of cases) {
  test(`Markdown: ${name}`, () => assert.deepEqual(extractQuotes(source), expected));
}

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

function fixture() {
  const session = SessionManager.inMemory();
  const notices: Array<{ text: string; type: string }> = [];
  const copies: string[] = [];
  const selections: string[][] = [];
  const state = { choice: undefined as number | undefined };
  const ctx = {
    mode: "tui",
    sessionManager: session,
    ui: {
      notify: (text: string, type: string) => notices.push({ text, type }),
      select: async (_title: string, options: string[]) => {
        selections.push(options);
        return state.choice === undefined ? undefined : options[state.choice];
      },
    },
  } as unknown as ExtensionCommandContext;
  return { session, notices, copies, selections, state, ctx, run: () => copyQuote(ctx, async (text) => { copies.push(text); }) };
}

test("registers the copy-quote command", () => {
  const commands = new Map<string, Omit<RegisteredCommand, "name">>();
  copyQuoteExtension({ registerCommand: (name: string, command: Omit<RegisteredCommand, "name">) => commands.set(name, command) } as unknown as ExtensionAPI);
  assert.equal(commands.size, 1);
  assert.ok(commands.get("copy-quote")?.handler);
});

test("manifest loads the extension and its isolated parser dependency through Pi", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-copy-quote-test-"));
  try {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: join(directory, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [{ source: packageRoot, extensions: ["extensions/copy-quote/index.ts"] }] }),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0].commands.has("copy-quote"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one quote copies immediately without altering the session", async () => {
  const f = fixture();
  f.session.appendMessage(assistant("> answer"));
  const before = structuredClone(f.session.getEntries());
  await f.run();
  assert.deepEqual(f.copies, ["answer"]);
  assert.deepEqual(f.selections, []);
  assert.match(f.notices[0].text, /copied/);
  assert.deepEqual(f.session.getEntries(), before);
});

test("multiple quotes offer numbered choices, including identical previews", async () => {
  const f = fixture();
  const shared = "a".repeat(140);
  f.session.appendMessage(assistant(`> ${shared} first\n\ntext\n\n> ${shared} second`));
  f.state.choice = 1;
  await f.run();
  assert.deepEqual(f.copies, [`${shared} second`]);
  assert.equal(f.selections[0].length, 2);
  assert.notEqual(f.selections[0][0], f.selections[0][1]);
});

test("picker cancellation does not copy or report success", async () => {
  const f = fixture();
  f.session.appendMessage(assistant("> one\n\ntext\n\n> two"));
  await f.run();
  assert.deepEqual(f.copies, []);
  assert.deepEqual(f.notices, []);
});

test("no quote in latest response does not fall back to older quotes", async () => {
  const f = fixture();
  f.session.appendMessage(assistant("> old"));
  f.session.appendMessage(assistant("No quote here."));
  await f.run();
  assert.deepEqual(f.copies, []);
  assert.match(f.notices[0].text, /No blockquotes/);
});

test("uses only the current branch and resolves it afresh for each command", async () => {
  const f = fixture();
  const root = f.session.appendMessage({ role: "user", content: "Question", timestamp: Date.now() });
  const first = f.session.appendMessage(assistant("> first branch"));
  f.session.branch(root);
  f.session.appendMessage(assistant("> second branch"));
  await f.run();
  f.session.branch(first);
  await f.run();
  assert.deepEqual(f.copies, ["second branch", "first branch"]);
});

test("uses latest completed response, skipping aborted, error and tool-call messages", async () => {
  const f = fixture();
  f.session.appendMessage(assistant("> completed"));
  for (const stop of ["aborted", "error", "toolUse", "length"] as const) f.session.appendMessage(assistant(`> ${stop}`, stop));
  f.session.appendMessage({ role: "user", content: "> user quote", timestamp: Date.now() });
  await f.run();
  assert.deepEqual(f.copies, ["completed"]);
});

test("thinking is excluded and separate text blocks stay separate", async () => {
  const f = fixture();
  f.session.appendMessage({ ...assistant(""), content: [
    { type: "thinking", thinking: "> private" },
    { type: "text", text: "> first" },
    { type: "text", text: "> second" },
  ] });
  f.state.choice = 1;
  await f.run();
  assert.equal(f.selections[0].length, 2);
  assert.deepEqual(f.copies, ["second"]);
});

test("empty branch and incomplete-only branch notify without copying", async () => {
  const f = fixture();
  await f.run();
  f.session.appendMessage(assistant("> incomplete", "aborted"));
  await f.run();
  assert.deepEqual(f.copies, []);
  assert.ok(f.notices.every((notice) => /No completed assistant response/.test(notice.text)));
});

test("clipboard failure is reported instead of success", async () => {
  const f = fixture();
  f.session.appendMessage(assistant("> answer"));
  await copyQuote(f.ctx, async () => { throw new Error("clipboard unavailable"); });
  assert.deepEqual(f.notices, [{ text: "Could not copy quote: clipboard unavailable", type: "error" }]);
});

test("non-terminal modes cannot overwrite the host clipboard", async () => {
  const f = fixture();
  f.session.appendMessage(assistant("> answer"));
  f.ctx.mode = "rpc";
  await f.run();
  assert.deepEqual(f.copies, []);
  assert.match(f.notices[0].text, /requires terminal interactive mode/);
});
