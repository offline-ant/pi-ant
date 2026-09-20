import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TERMINAL_INPUT_EXTENSION, terminalRequest } from "../orchestration/terminal-input.ts";
import { HerdrFinishClient, type HerdrPane } from "./herdr-finish-client.ts";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("../orchestration/test/lifecycle-fixture.ts", import.meta.url));
const extension = fileURLToPath(new URL("./herdr-finish.ts", import.meta.url));
type NativePane = { pane: HerdrPane; directory: string; control: string };
type Trace = { event: string; prompt?: string; draft?: string; commands?: string[]; provider?: string };

// Real Pi TUIs, production finish commands and the installed managed integration.
// Faux inference is held by fixture-owned files; never report fake states at a shell.
test("Herdr native finish: TUI commands, late agents, blocked waiters, cancellation and drafts", {
  skip: process.env.PI_HERDR_FINISH_NATIVE !== "1",
  timeout: 180_000,
}, async (t) => {
  assert.equal(process.env.HERDR_ENV, "1", "Run inside Herdr; never attach to an outside user's session");
  const endpoint = process.env.HERDR_SOCKET_PATH;
  assert.ok(endpoint, "HERDR_SOCKET_PATH must identify the installed server");
  assert.ok((await stat(endpoint)).isSocket());
  const integration = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "extensions", "herdr-agent-state.ts");
  await stat(integration);
  const client = new HerdrFinishClient(endpoint);
  const directory = await mkdtemp(join(tmpdir(), "pi-finish-native-"));
  const name = `finish-${randomUUID().slice(0, 8)}`;
  let workspaceId: string | undefined;
  const owned: NativePane[] = [];

  async function cli(...args: string[]): Promise<string> {
    return (await exec(process.env.HERDR_BIN_PATH || "herdr", args, {
      timeout: 40_000, env: { ...process.env, HERDR_SOCKET_PATH: endpoint },
    })).stdout;
  }
  async function until(predicate: () => boolean | Promise<boolean>, label: string) {
    const deadline = Date.now() + 15_000;
    while (!await predicate()) {
      t.signal.throwIfAborted();
      assert.ok(Date.now() < deadline, `Timed out: ${label}`);
      await delay(50, undefined, { signal: t.signal });
    }
  }
  async function create(...args: string[]): Promise<NativePane> {
    const cwd = join(directory, String(owned.length));
    await mkdir(cwd);
    const control = join(cwd, "input.sock");
    const response = JSON.parse(await cli(...args, "--cwd", cwd, "--no-focus",
      "--env", `PI_ORCHESTRATION_CONTROL=${control}`,
      "--env", `PI_CODING_AGENT_DIR=${join(cwd, "agent")}`)) as {
      result: { workspace?: { workspace_id: string }; root_pane?: HerdrPane; pane?: HerdrPane };
    };
    // Record ownership before checking the rest, so failed startup still cleans up.
    if (response.result.workspace) workspaceId = response.result.workspace.workspace_id;
    const pane = response.result.root_pane ?? response.result.pane;
    assert.ok(pane?.pane_id);
    assert.equal(pane.workspace_id, workspaceId);
    const target = { pane, directory: cwd, control };
    owned.push(target);
    return target;
  }
  async function start(target: NativePane) {
    const args = ["agent", "start", `${name}-${owned.indexOf(target)}`, "--kind", "pi", "--pane", target.pane.pane_id,
      "--", "--offline", "--session", join(target.directory, "session.jsonl"),
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools",
      "--model", "orchestration-fixture/one", "--thinking", "off",
      "-e", fixture, "-e", integration, "-e", extension, "-e", TERMINAL_INPUT_EXTENSION];
    await until(async () => {
      try { await cli(...args); return true; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("agent_pane_busy")) throw error;
        return false;
      }
    }, `start Pi in ${target.pane.pane_id}`);
    await until(() => existsSync(target.control), "private Pi input endpoint");
    await terminalRequest(target.control, { kind: "ping" }, t.signal);
    await status(target, "idle", "done");
    const startup = traces(target).find((entry) => entry.event === "startup");
    assert.equal(startup?.provider, "orchestration-fixture");
    // lifecycle-fixture reports before finish's session_start registers commands.
    await report(target);
    assert.ok(traces(target).at(-1)?.commands?.includes("start-tab-finish"));
  }
  function traces(target: NativePane): Trace[] {
    const file = join(target.directory, "lifecycle-trace.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Trace) : [];
  }
  function requests(target: NativePane): string[] {
    return traces(target).filter((entry) => entry.event === "request").map((entry) => entry.prompt!);
  }
  async function prompt(target: NativePane, text: string) {
    await terminalRequest(target.control, { kind: "prompt", text }, t.signal);
  }
  async function status(target: NativePane, ...states: string[]) {
    await until(async () => {
      const pane = (await client.panes(t.signal)).find((item) => item.pane_id === target.pane.pane_id);
      return pane?.agent === "pi" && states.includes(pane.agent_status);
    }, `${target.pane.pane_id}: ${states.join("/")}`);
  }
  async function waiting(target: NativePane, scope: "tab" | "space", count: number) {
    await status(target, "blocked");
    // Hidden/small panes can put the widget above their visible viewport. Read
    // the recent render, but match only its last widget to reject stale counts.
    await until(async () => {
      const text = await cli("pane", "read", target.pane.pane_id, "--source", "recent", "--lines", "80");
      const last = [...text.matchAll(/Waiting for Herdr (tab|space): (\d+) remaining/g)].at(-1);
      return last?.[1] === scope && last[2] === String(count);
    }, `live ${scope} widget: ${count} pending`);
  }
  async function report(target: NativePane) {
    const before = traces(target).filter((entry) => entry.event === "report").length;
    await prompt(target, "/lifecycle-report");
    await until(() => traces(target).filter((entry) => entry.event === "report").length > before, "draft report");
  }
  async function hold(target: NativePane, label: string) {
    await rm(join(target.directory, "release"), { force: true });
    await prompt(target, `[hold] ${label}`);
    await status(target, "working");
  }
  async function release(target: NativePane) {
    await writeFile(join(target.directory, "release"), "");
    await status(target, "idle", "done");
  }
  async function completed(target: NativePane, expected: string[]) {
    await until(() => requests(target).length >= expected.length, "scheduled faux inference");
    await status(target, "idle", "done");
    assert.deepEqual(requests(target), expected);
  }

  try {
    t.diagnostic((await cli("status")).trim());
    const self = await create("workspace", "create", "--label", name);
    await start(self);
    const worker = await create("pane", "split", self.pane.pane_id, "--direction", "right");
    await start(worker);
    const shell = await create("pane", "split", worker.pane.pane_id, "--direction", "down");
    const otherTab = await create("tab", "create", "--workspace", workspaceId!);
    await start(otherTab);
    assert.equal(worker.pane.tab_id, self.pane.tab_id);
    assert.notEqual(otherTab.pane.tab_id, self.pane.tab_id);
    await hold(worker, "first worker");
    await hold(otherTab, "other tab");
    await cli("pane", "send-text", self.pane.pane_id, "human draft unchanged");
    await report(self);
    assert.equal(traces(self).at(-1)?.draft, "human draft unchanged");
    await prompt(self, "/start-tab-finish tab finished");
    // Shells and agents in another tab do not count; the root excludes itself.
    await waiting(self, "tab", 1);
    assert.deepEqual(requests(self), []);

    // A previously agentless shell becomes a real Pi while the wait is active.
    await start(shell);
    await hold(shell, "late arrival");
    await waiting(self, "tab", 2);
    await release(worker);
    await waiting(self, "tab", 1);
    assert.deepEqual(requests(self), []);
    await release(shell);
    await completed(self, ["tab finished"]);
    await status(otherTab, "working");
    await report(self);
    assert.equal(traces(self).at(-1)?.draft, "human draft unchanged");

    await prompt(self, "/start-space-finish space finished");
    await waiting(self, "space", 1);
    await prompt(shell, "/start-space-finish must never fire");
    await waiting(self, "space", 2);
    await waiting(shell, "space", 2);
    await release(otherTab);
    await waiting(self, "space", 1);
    await waiting(shell, "space", 1);
    // Two blocked waiters must not count one another as completed.
    await delay(500, undefined, { signal: t.signal });
    assert.deepEqual(requests(self), ["tab finished"]);
    assert.deepEqual(requests(shell), ["[hold] late arrival"]);
    await prompt(shell, "/start-finish-cancel");
    await status(shell, "idle", "done");
    await completed(self, ["tab finished", "space finished"]);

    await hold(otherTab, "cancelled wait");
    await prompt(self, "/start-space-finish cancelled prompt");
    await waiting(self, "space", 1);
    await prompt(self, "/start-finish-cancel");
    await status(self, "idle", "done");
    await release(otherTab);
    // Allow queued status events to expose duplicate or cancelled submissions.
    await delay(1_200, undefined, { signal: t.signal });
    assert.deepEqual(requests(self), ["tab finished", "space finished"]);
    assert.deepEqual(requests(shell), ["[hold] late arrival"]);
    await report(self);
    assert.equal(traces(self).at(-1)?.draft, "human draft unchanged");
    t.diagnostic("Passed: real Pi TUI commands and managed herdr:pi reports; subscription acknowledgement/events; tab/workspace scope; shell exclusion and late agent arrival; working→idle/done; blocked waiters; explicit cancellation; exactly-once local prompts; human draft preserved.");
  } catch (error) {
    for (const target of owned) {
      t.diagnostic(`${target.pane.pane_id}: ${await cli("pane", "read", target.pane.pane_id, "--source", "recent", "--lines", "60").catch(String)}`);
    }
    throw error;
  } finally {
    // Never close an existing user pane or restart the installed Herdr server.
    if (workspaceId) await cli("workspace", "close", workspaceId);
    await rm(directory, { recursive: true, force: true });
  }
});
