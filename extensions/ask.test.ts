import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { flushSessionFile } from "../orchestration/context.ts";
import { forkFixture } from "../orchestration/test/fork-fixture.ts";
import askExtension from "./ask.ts";

type AskExecute = (id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: unknown) => Promise<{
  details: { results: Array<{ selectedOptions: string[]; customInput?: string }>; cancelled: boolean };
}>;

function askFixture() {
  const fixture = forkFixture();
  let execute!: AskExecute;
  Object.assign(fixture.pi, {
    registerTool: (tool: { execute: AskExecute }) => { execute = tool.execute; },
  });
  askExtension(fixture.pi);
  return { ...fixture, execute };
}

const questions = [{ id: "choice", question: "Which option?", options: [{ label: "A" }, { label: "B" }], multi: true }];

for (const mode of ["rpc", "tui"] as const) test(`${mode} ask discussion forks before the tool call while keeping question and selections open`, async () => {
  const fixture = askFixture();
  fixture.session.appendMessage({
    role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask", arguments: { questions } }],
    api: "openai-responses", provider: "fixture", model: "fake", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  flushSessionFile(fixture.session, fixture.sessionFile);
  const bytes = fs.readFileSync(fixture.sessionFile, "utf8");
  const branch = fixture.session.getLeafId();
  let selection = 0;
  let finished = false;
  const ctx = {
    cwd: fixture.directory, hasUI: true, mode, sessionManager: fixture.session,
    model: { provider: "fixture", id: "fake" }, isIdle: () => false,
    ui: {
      select: async (_title: string, choices: string[]) => {
        selection++;
        if (selection === 1) return choices.find((choice) => choice.includes("[ ] A"));
        if (selection === 2) return choices.find((choice) => choice.includes("Fork (discuss separately)"));
        assert.equal(finished, false, "parent ask must remain pending after fork creation");
        assert.equal(fixture.prompts.length, 1);
        assert.ok(choices.some((choice) => choice.includes("[x] A")), "fork must preserve selections");
        return choices.find((choice) => choice.includes("Done selecting"));
      },
      editor: async (_title: string, prefill: string) => {
        assert.ok(prefill.includes("Which option?"));
        assert.ok(prefill.includes("Current answer: [A]"));
        return "Discuss this choice separately";
      },
      custom: async (factory: (tui: unknown, theme: unknown, keys: KeybindingsManager, done: (result: unknown) => void) => { render: (width: number) => string[]; handleInput: (data: string) => void; dispose: () => void }) => {
        assert.equal(mode, "tui", "RPC ask must use standard dialogs");
        selection++;
        return new Promise((resolve) => {
          const component = factory({ requestRender: () => undefined }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, new KeybindingsManager(TUI_KEYBINDINGS), resolve);
          if (selection === 3) {
            assert.equal(finished, false);
            assert.equal(fixture.prompts.length, 1);
            assert.ok(component.render(100).some((line) => line.includes("[x] A")));
          }
          const moves = selection === 1 ? 0 : selection === 2 ? 4 : 2;
          for (let move = 0; move < moves; move++) component.handleInput("\u001b[B");
          component.handleInput("\r");
          component.dispose();
        });
      },
      setEditorText: () => assert.fail("must not overwrite parent draft"),
      notify: (text: string) => { if (text.startsWith("Started ")) fixture.targets.push(text.split(".")[0].slice(8)); },
    },
  };
  try {
    const result = await fixture.execute("ask-call", { questions }, undefined, undefined, ctx);
    finished = true;
    assert.equal(result.details.cancelled, false);
    assert.deepEqual(result.details.results[0].selectedOptions, ["A"]);
    assert.deepEqual(fixture.prompts, ["Discuss this choice separately"]);
    assert.equal(fixture.session.getLeafId(), branch);
    assert.equal(fs.readFileSync(fixture.sessionFile, "utf8"), bytes);
    const child = SessionManager.open(fixture.children[0]);
    assert.equal(child.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant"), false);
  } finally { await fixture.cleanup(); }
});

test("RPC ask cancellation, edited answers, and unavailable UI are explicit", async () => {
  const fixture = askFixture();
  try {
    const ctx = { hasUI: true, mode: "rpc", ui: { select: async () => undefined } };
    const cancelled = await fixture.execute("cancel", { questions }, undefined, undefined, ctx);
    assert.equal(cancelled.details.cancelled, true);
    const unavailable = await fixture.execute("none", { questions }, undefined, undefined, { hasUI: false });
    assert.equal(unavailable.details.cancelled, true);
    const edited = await fixture.execute("edit", { questions: [{ ...questions[0], multi: false }] }, undefined, undefined, {
      hasUI: true, mode: "rpc", ui: {
        select: async (_title: string, choices: string[]) => choices.find((choice) => choice.includes("Edit: A")),
        editor: async (_title: string, prefill: string) => `${prefill} with changes`,
      },
    });
    assert.equal(edited.details.cancelled, false);
    assert.equal(edited.details.results[0].customInput, "A with changes");
    assert.equal(fixture.commands.length, 0);
  } finally { await fixture.cleanup(); }
});

test("cancelled discussion editor returns to the same RPC question without spawning", async () => {
  const fixture = askFixture();
  let count = 0;
  try {
    const result = await fixture.execute("cancel-discuss", { questions: [{ ...questions[0], multi: false }] }, undefined, undefined, {
      hasUI: true, mode: "rpc", ui: {
        select: async (_title: string, choices: string[]) => {
          count++;
          return choices.find((choice) => choice.includes(count === 1 ? "Fork (discuss separately)" : ". A"));
        },
        editor: async () => undefined,
      },
    });
    assert.deepEqual(result.details.results[0].selectedOptions, ["A"]);
    assert.equal(fixture.commands.length, 0);
  } finally { await fixture.cleanup(); }
});
