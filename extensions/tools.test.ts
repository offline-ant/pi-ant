import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import toolsExtension, { showToolDialogs } from "./tools.ts";
import { createProfileState, TOOL_CONTROL_STATE_TYPE, type ToolControlState } from "./tool-control-state.ts";

test("RPC tool dialogs toggle, enforce required tools, save, and apply profiles", async () => {
  const selections = ["Toggle tools", "[required] sqlite", "[ ] browser", "Done", "Save as default", "Apply profile", "Coding", "Apply profile", "Default", "Done"];
  const changes: ToolControlState[] = [];
  const saves: ToolControlState[] = [];
  const notices: string[] = [];
  const ctx = {
    mode: "rpc",
    ui: {
      select: async (_title: string, options: string[]) => {
        const expected = selections.shift();
        const choice = options.find((option) => option.startsWith(expected ?? ""));
        assert.ok(choice, `No choice for ${expected}: ${options.join(", ")}`);
        return choice;
      },
      notify: (text: string) => notices.push(text),
      custom: () => assert.fail("RPC must not call custom"),
    },
  } as unknown as ExtensionContext;
  await showToolDialogs(ctx, {
    state: createProfileState("coding"),
    savedDefault: createProfileState("research"),
    tools: ["read", "browser", "sqlite"].map((name) => ({ name, description: name })) as ToolInfo[],
    required: new Set(["sqlite"]),
    onStateChange: (state) => changes.push(state),
    onSaveDefault: (state) => { saves.push(state); return true; },
  });
  assert.equal(selections.length, 0);
  assert.equal(changes.length, 3);
  assert.ok(changes[0].enabledTools.includes("browser"));
  assert.ok(!changes[1].enabledTools.includes("browser"));
  assert.deepEqual(changes[2].enabledTools, changes[0].enabledTools);
  assert.equal(saves.length, 1);
  assert.equal(notices.length, 1);
});

test("RPC tool dialog cancellation leaves state unchanged", async () => {
  const ctx = { ui: { select: async () => undefined } } as unknown as ExtensionContext;
  await showToolDialogs(ctx, {
    state: createProfileState("coding"), savedDefault: createProfileState("research"), tools: [], required: new Set(),
    onStateChange: () => assert.fail("cancel changed state"),
    onSaveDefault: () => { assert.fail("cancel saved state"); },
  });
});

test("an interactive fork releases inherited worker ownership and restores exact available tools", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let active: string[] = [];
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    registerCommand: () => undefined,
    getAllTools: () => ["read", "ask", "delegate"].map((name) => ({ name })),
    setActiveTools: (tools: string[]) => { active = tools; },
    events: { emit: () => undefined },
  } as unknown as Parameters<typeof toolsExtension>[0];
  toolsExtension(pi);
  const ctx = {
    cwd: "/tmp",
    sessionManager: { getBranch: () => [
      { type: "custom", customType: "pi-orchestration:delegate-runtime", data: {} },
      { type: "custom", customType: "pi-orchestration:fork", data: {} },
      { type: "custom", customType: TOOL_CONTROL_STATE_TYPE, data: { ...createProfileState("research"), enabledTools: ["read", "unavailable"] } },
    ] },
    ui: { setStatus: () => undefined, theme: { fg: (_color: string, text: string) => text } },
  };
  await handlers.get("session_start")?.({}, ctx);
  assert.deepEqual(active, ["read"]);
});
