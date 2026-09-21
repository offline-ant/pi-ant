import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import toolsExtension, { showToolDialog } from "./tools.ts";
import { TOOL_SELECTION_ENTRY } from "./tool-selection.ts";

function scriptedContext(selections: string[], notices: string[] = []): ExtensionContext {
  return {
    mode: "rpc",
    ui: {
      select: async (_title: string, options: string[]) => {
        const expected = selections.shift();
        if (expected === undefined) return undefined;
        const choice = options.find((option) => option.startsWith(expected));
        assert.ok(choice, `No choice for ${expected}: ${options.join(", ")}`);
        return choice;
      },
      notify: (text: string) => notices.push(text),
      custom: () => assert.fail("RPC must not call custom"),
    },
  } as unknown as ExtensionContext;
}

test("RPC tool dialog toggles, enforces required tools, and saves the default", async () => {
  const selections = ["[required] present_guidance", "[ ] browser", "[x] browser", "[ ] fresh_look", "Save as default", "Done"];
  const notices: string[] = [];
  const changes: string[][] = [];
  const saves: string[][] = [];
  const initial = ["read"];
  await showToolDialog(scriptedContext(selections, notices), {
    selection: initial,
    savedDefault: undefined,
    tools: ["read", "browser", "fresh_look", "present_guidance"].map((name) => ({ name, description: name })) as ToolInfo[],
    required: new Set(["present_guidance"]),
    onChange: (selection) => changes.push(selection),
    onSaveDefault: (selection) => { saves.push(selection); return true; },
  });
  assert.equal(selections.length, 0);
  assert.deepEqual(changes, [["read", "browser"], ["read"], ["read", "fresh_look"]]);
  assert.deepEqual(saves, [["read", "fresh_look"]]);
  assert.equal(notices.length, 1);
  assert.deepEqual(initial, ["read"]);
});

test("RPC tool dialog cancellation leaves the selection unchanged", async () => {
  await showToolDialog(scriptedContext([]), {
    selection: ["read"], savedDefault: ["read"], tools: [], required: new Set(),
    onChange: () => assert.fail("cancel changed the selection"),
    onSaveDefault: () => assert.fail("cancel saved the selection"),
  });
});

async function startSession(branch: unknown[], savedDefault?: unknown): Promise<string[] | undefined> {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tools-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    if (savedDefault !== undefined) fs.writeFileSync(path.join(agentDir, "tool-selection.json"), JSON.stringify(savedDefault));
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    let active: string[] | undefined;
    toolsExtension({
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
      registerCommand: () => undefined,
      getAllTools: () => ["read", "ask", "do", "delegate", "fresh_look"].map((name) => ({ name })),
      setActiveTools: (tools: string[]) => { active = tools; },
    } as unknown as Parameters<typeof toolsExtension>[0]);
    await handlers.get("session_start")?.({}, { cwd: "/tmp", sessionManager: { getBranch: () => branch } });
    return active;
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test("without a branch selection or saved default, Pi's active tools are left alone", async () => {
  assert.equal(await startSession([]), undefined);
});

test("the saved default applies to branches without their own selection", async () => {
  assert.deepEqual(await startSession([], { enabledTools: ["read", "do"] }), ["read", "do"]);
});

test("an interactive fork releases inherited worker ownership and restores exact available tools", async () => {
  assert.deepEqual(await startSession([
    { type: "custom", customType: "pi-orchestration:delegate-runtime", data: {} },
    { type: "custom", customType: "pi-orchestration:fork", data: {} },
    { type: "custom", customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["read", "unavailable"] } },
  ], { enabledTools: ["do"] }), ["read"]);
});

test("structured workers keep the tools their request selected", async () => {
  assert.equal(await startSession([
    { type: "custom", customType: "pi-orchestration:delegate-runtime", data: {} },
  ], { enabledTools: ["do"] }), undefined);
});
