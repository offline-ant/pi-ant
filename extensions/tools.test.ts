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

interface FakeSession {
  active: string[] | undefined;
  registered: string[];
  branch: unknown[];
  emit(event: "session_start" | "session_tree" | "input"): Promise<void>;
  saveDefault(value: unknown): void;
  dispose(): void;
}

function fakeSession(branch: unknown[], savedDefault?: unknown): FakeSession {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tools-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const session: FakeSession = {
    active: undefined,
    registered: ["read", "ask", "do", "delegate", "fresh_look", "codemode", "tool_search"],
    branch,
    emit: async (event) => {
      await handlers.get(event)?.({}, { cwd: "/tmp", sessionManager: { getBranch: () => session.branch } });
    },
    saveDefault: (value) => fs.writeFileSync(path.join(agentDir, "tool-selection.json"), JSON.stringify(value)),
    dispose: () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(agentDir, { recursive: true, force: true });
    },
  };
  if (savedDefault !== undefined) session.saveDefault(savedDefault);
  toolsExtension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    registerCommand: () => undefined,
    getAllTools: () => session.registered.map((name) => ({ name })),
    getActiveTools: () => session.active ?? [],
    setActiveTools: (tools: string[]) => { session.active = tools; },
  } as unknown as Parameters<typeof toolsExtension>[0]);
  return session;
}

async function startSession(branch: unknown[], savedDefault?: unknown): Promise<string[] | undefined> {
  const session = fakeSession(branch, savedDefault);
  try {
    await session.emit("session_start");
    return session.active;
  } finally {
    session.dispose();
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

test("activations Pi makes after the selection was applied survive later prompts", async () => {
  const session = fakeSession([], { enabledTools: ["read", "do"] });
  try {
    await session.emit("session_start");
    // An MCP server connects: its codemode-exposed tool registers inactive and Pi enables codemode.
    session.registered.push("mcp_search");
    session.active = [...session.active!, "codemode", "tool_search"];
    await session.emit("input");
    // tool_search declares a match for the following calls.
    session.active = [...session.active, "mcp_search"];
    await session.emit("input");
    assert.deepEqual(session.active, ["read", "do", "codemode", "tool_search", "mcp_search"]);
  } finally {
    session.dispose();
  }
});

test("a changed saved default, ended Ugo control, or branch change reapplies the selection", async () => {
  const session = fakeSession([], { enabledTools: ["read"] });
  try {
    await session.emit("session_start");
    session.active = [...session.active!, "codemode"];
    session.saveDefault({ enabledTools: ["read", "ask"] });
    await session.emit("input");
    assert.deepEqual(session.active, ["read", "ask"]);

    session.branch = [{ type: "custom", customType: "pi-ant:ugo-state", data: { active: true } }];
    session.active = ["present_guidance"];
    await session.emit("input");
    assert.deepEqual(session.active, ["present_guidance"]);
    session.branch = [...session.branch, { type: "custom", customType: "pi-ant:ugo-state", data: { active: false } }];
    await session.emit("input");
    assert.deepEqual(session.active, ["read", "ask"]);

    session.active = [...session.active, "codemode"];
    session.branch = [{ type: "custom", customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["read", "ask"] } }];
    await session.emit("session_tree");
    assert.deepEqual(session.active, ["read", "ask"]);
  } finally {
    session.dispose();
  }
});

test("selected tools registered after the selection was applied become active", async () => {
  const session = fakeSession([], { enabledTools: ["read", "mcp_direct"] });
  try {
    await session.emit("session_start");
    assert.deepEqual(session.active, ["read"]);
    session.registered.push("mcp_direct", "mcp_other");
    session.active = [...session.active!, "codemode"];
    await session.emit("input");
    assert.deepEqual(session.active, ["read", "codemode", "mcp_direct"]);
  } finally {
    session.dispose();
  }
});
