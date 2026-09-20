import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import herdrFinish from "./herdr-finish.ts";
import { HerdrApiError, HerdrFinishClient, type HerdrPane, type HerdrSubscription } from "./herdr-finish-client.ts";
import { waitForHerdrFinish, type FinishScope } from "./herdr-finish-wait.ts";

function pane(id: string, status = "working", tab = "t1", workspace = "w1"): HerdrPane {
  return {
    pane_id: id, terminal_id: `term-${id}`, workspace_id: workspace, tab_id: tab,
    agent: "pi", agent_status: status, agent_session: { value: `session-${id}` },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await delay(1);
  }
}

function fixture(t: TestContext) {
  const state = {
    panes: [pane("self", "blocked"), pane("other")],
    queries: 0,
    snapshot: undefined as (() => Promise<HerdrPane[]>) | undefined,
    beforeSubscribe: undefined as ((subscriptions: HerdrSubscription[]) => void) | undefined,
  };
  const subscriptions: Array<{ specs: HerdrSubscription[]; changed: () => void; failed: (error: Error) => void; closed: boolean }> = [];
  t.mock.method(HerdrFinishClient.prototype, "panes", async () => {
    state.queries++;
    return state.snapshot ? state.snapshot() : structuredClone(state.panes);
  });
  t.mock.method(HerdrFinishClient.prototype, "subscribe", async (
    specs: HerdrSubscription[], changed: () => void, failed: (error: Error) => void,
  ) => {
    state.beforeSubscribe?.(specs);
    const entry = { specs, changed, failed, closed: false };
    subscriptions.push(entry);
    return () => { entry.closed = true; };
  });
  const change = () => { for (const entry of subscriptions) if (!entry.closed) entry.changed(); };
  function start(scope: FinishScope = "tab", blockedTimeoutMs = 1_000) {
    const controller = new AbortController();
    const outcome = { settled: false, error: undefined as unknown, pending: undefined as HerdrPane[] | undefined };
    const done = waitForHerdrFinish({
      endpoint: "unused", paneId: "self", sessionRef: "session-self", scope, signal: controller.signal, blockedTimeoutMs,
      progress: (pending) => { outcome.pending = pending; },
    }).then(() => { outcome.settled = true; }, (error: unknown) => { outcome.error = error; outcome.settled = true; });
    t.after(async () => { controller.abort(); await done; });
    return { controller, outcome, done };
  }
  return { state, subscriptions, change, start };
}

const settings = { timeout: 5_000 };

test("live tab scope includes late agents, ignores shells and other tabs/workspaces, and does not poll", settings, async (t) => {
  const f = fixture(t);
  f.state.panes.push({ ...pane("shell"), agent: undefined }, pane("outside", "working", "t2"), pane("remote", "working", "t1", "w2"));
  const wait = f.start();
  await until(() => wait.outcome.pending?.length === 1);
  assert.deepEqual(wait.outcome.pending?.map((p) => p.pane_id), ["other"]);
  const queries = f.state.queries;
  await delay(15);
  assert.equal(f.state.queries, queries, "unchanged state must not produce periodic queries");
  f.state.panes.push(pane("late"));
  f.change();
  await until(() => wait.outcome.pending?.length === 2);
  assert.ok(f.subscriptions.some((s) => !s.closed && s.specs.some((s) => s.pane_id === "late")));
  f.state.panes.find((p) => p.pane_id === "other")!.agent_status = "done";
  f.change();
  await until(() => wait.outcome.pending?.[0]?.pane_id === "late");
  assert.equal(wait.outcome.settled, false);
  f.state.panes.find((p) => p.pane_id === "late")!.agent_status = "idle";
  f.change();
  await wait.done;
  assert.equal(wait.outcome.error, undefined);
  assert.ok(f.subscriptions.every((s) => s.closed));
});

test("space waits count blocked and unknown agents across tabs, including agents that become busy again", settings, async (t) => {
  const f = fixture(t);
  f.state.panes[1].agent_status = "unknown";
  f.state.panes.push(pane("second-waiter", "blocked", "t2"));
  const wait = f.start("space");
  await until(() => wait.outcome.pending?.length === 2);
  f.state.panes[1].agent_status = "done";
  f.change();
  await until(() => wait.outcome.pending?.length === 1);
  f.state.panes[1].agent_status = "working";
  f.change();
  await until(() => wait.outcome.pending?.length === 2);
  f.state.panes = f.state.panes.filter((p) => p.pane_id !== "second-waiter");
  f.change();
  await until(() => wait.outcome.pending?.length === 1);
  assert.equal(wait.outcome.settled, false);
  f.state.panes[1].agent_status = "idle";
  f.change();
  await wait.done;
  assert.equal(wait.outcome.error, undefined);
});

test("fresh snapshot after subscription sees changes during setup, including a shell becoming an agent", settings, async (t) => {
  const f = fixture(t);
  f.state.panes[1].agent = undefined;
  f.state.beforeSubscribe = (specs) => {
    if (specs.some((s) => s.pane_id === "other")) f.state.panes[1].agent = "codex";
  };
  const wait = f.start();
  await until(() => wait.outcome.pending?.length === 1);
  assert.equal(wait.outcome.settled, false);
  assert.equal(wait.outcome.pending?.[0].agent, "codex");
});

test("an event during a snapshot invalidates an otherwise-ready response", settings, async (t) => {
  const f = fixture(t);
  const wait = f.start();
  await until(() => wait.outcome.pending?.length === 1);
  f.state.snapshot = async () => {
    f.state.snapshot = undefined;
    const stale = structuredClone(f.state.panes);
    stale[1].agent_status = "idle";
    f.change();
    return stale;
  };
  const queries = f.state.queries;
  f.change();
  await until(() => f.state.queries >= queries + 2);
  assert.equal(wait.outcome.settled, false);
  assert.equal(wait.outcome.pending?.[0].agent_status, "working");
});

test("a pane disappearing during subscription setup is removed by a fresh query", settings, async (t) => {
  const f = fixture(t);
  f.state.beforeSubscribe = (specs) => {
    if (specs.some((s) => s.pane_id === "other")) {
      f.state.panes.pop();
      throw new HerdrApiError("pane_not_found", "closed");
    }
  };
  const wait = f.start();
  await wait.done;
  assert.equal(wait.outcome.error, undefined);
});

test("readiness requires an observed blocked report even with no other agents", settings, async (t) => {
  const f = fixture(t);
  f.state.panes = [pane("self", "idle")];
  const wait = f.start();
  await until(() => wait.outcome.pending?.length === 0);
  assert.equal(wait.outcome.settled, false);
  f.state.panes[0].agent_status = "blocked";
  f.change();
  await wait.done;
  assert.equal(wait.outcome.error, undefined);
});

test("a missing blocked report has a bounded failure, not an accidental launch", settings, async (t) => {
  const f = fixture(t);
  f.state.panes = [pane("self", "idle")];
  const wait = f.start("tab", 20);
  await wait.done;
  assert.match(String(wait.outcome.error), /did not report this Pi as blocked/);
  assert.ok(f.subscriptions.every((s) => s.closed));
});

for (const change of ["session", "scope", "terminal", "missing", "lost-block", "disconnect"] as const) {
  test(`fail closed on caller ${change}`, settings, async (t) => {
    const f = fixture(t);
    const wait = f.start();
    await until(() => wait.outcome.pending?.length === 1);
    if (change === "session") f.state.panes[0].agent_session = { value: "replacement" };
    if (change === "scope") f.state.panes[0].tab_id = "other-tab";
    if (change === "terminal") f.state.panes[0].terminal_id = "replacement";
    if (change === "missing") f.state.panes.shift();
    if (change === "lost-block") f.state.panes[0].agent_status = "idle";
    if (change === "disconnect") f.subscriptions[0].failed(new Error("disconnected"));
    else f.change();
    await wait.done;
    assert.ok(wait.outcome.error instanceof Error);
    assert.ok(f.subscriptions.every((s) => s.closed));
  });
}

function extensionFixture(t: TestContext, mode = "tui", inside = true) {
  const f = fixture(t);
  const env = { HERDR_ENV: inside ? "1" : "0", HERDR_SOCKET_PATH: "unused", HERDR_PANE_ID: "self" };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const commands = new Map<string, Handler>();
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => void>();
  const notifications: string[] = [];
  const blocks: boolean[] = [];
  const prompts: string[] = [];
  const state = { idle: true, queued: false, widget: undefined as string[] | undefined, draft: "human draft", sendError: undefined as Error | undefined };
  const ctx = {
    mode, isIdle: () => state.idle, hasPendingMessages: () => state.queued,
    sessionManager: { getSessionFile: () => "session-self", getSessionId: () => "self" },
    ui: {
      notify: (text: string) => notifications.push(text),
      setWidget: (_key: string, lines: string[] | undefined) => { state.widget = lines; },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => void) => events.set(name, handler),
    registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec.handler),
    events: { emit: (name: string, data: { active: boolean }) => {
      assert.equal(name, "herdr:blocked");
      blocks.push(data.active);
      f.state.panes[0].agent_status = data.active ? "blocked" : "idle";
      f.change();
    } },
    sendUserMessage: (text: string) => {
      if (state.sendError) throw state.sendError;
      prompts.push(text);
      events.get("input")?.({ source: "extension", text }, ctx);
    },
  } as unknown as ExtensionAPI;
  herdrFinish(pi);
  events.get("session_start")?.({}, ctx);
  t.after(() => events.get("session_shutdown")?.({}, ctx));
  const run = (name: string, args = "") => commands.get(name)!(args, ctx);
  return { ...f, ctx, commands, events, notifications, blocks, prompts, uiState: state, run };
}

test("commands are absent outside Herdr and in inherited non-TUI modes", settings, async (t) => {
  for (const [mode, inside] of [["tui", false], ["rpc", true], ["print", true], ["json", true]] as const) {
    await t.test(`${mode}/${inside}`, (t) => {
      assert.equal(extensionFixture(t, mode, inside).commands.size, 0);
    });
  }
});

test("commands mark blocked, include late agents, and send exactly once without touching drafts", settings, async (t) => {
  const f = extensionFixture(t);
  assert.deepEqual([...f.commands.keys()], ["start-tab-finish", "start-space-finish", "start-finish-cancel"]);
  await f.run("start-tab-finish", "Review the changes\nand run tests");
  await until(() => f.uiState.widget?.some((s) => s.includes("other: working")) === true);
  assert.deepEqual(f.blocks, [true]);
  f.state.panes.push(pane("late", "blocked"));
  f.change();
  await until(() => f.uiState.widget?.some((s) => s.includes("late: blocked")) === true);
  f.state.panes[1].agent_status = "done";
  f.change();
  await until(() => f.uiState.widget?.[0].includes("1 remaining") === true);
  assert.deepEqual(f.prompts, []);
  f.state.panes[2].agent_status = "idle";
  f.change();
  await until(() => f.prompts.length === 1);
  f.change();
  assert.deepEqual(f.prompts, ["Review the changes\nand run tests"]);
  assert.deepEqual(f.blocks, [true, false]);
  assert.equal(f.uiState.widget, undefined);
  assert.equal(f.uiState.draft, "human draft");
});

test("empty prompts, busy/queued callers and duplicate schedules are rejected", settings, async (t) => {
  const f = extensionFixture(t);
  await f.run("start-tab-finish");
  assert.match(f.notifications.at(-1)!, /Usage/);
  f.uiState.idle = false;
  await f.run("start-tab-finish", "busy");
  assert.match(f.notifications.at(-1)!, /idle/);
  f.uiState.idle = true;
  f.uiState.queued = true;
  await f.run("start-space-finish", "queued");
  assert.equal(f.blocks.length, 0);
  f.uiState.queued = false;
  await f.run("start-tab-finish", "first");
  await f.run("start-space-finish", "second");
  assert.match(f.notifications.at(-1)!, /Already waiting/);
  assert.deepEqual(f.blocks, [true]);
});

for (const event of ["input", "agent_start", "session_tree", "session_shutdown", "command"] as const) {
  test(`${event} cancels the wait and removes the blocked hold exactly once`, settings, async (t) => {
    const f = extensionFixture(t);
    await f.run("start-tab-finish", "do not send");
    await until(() => f.state.queries >= 2);
    if (event === "command") await f.run("start-finish-cancel");
    else f.events.get(event)!({}, f.ctx);
    f.events.get("session_shutdown")!({}, f.ctx);
    f.state.panes[1].agent_status = "idle";
    f.change();
    await until(() => f.subscriptions.every((s) => s.closed));
    assert.deepEqual(f.blocks, [true, false]);
    assert.deepEqual(f.prompts, []);
    assert.equal(f.uiState.widget, undefined);
  });
}

test("cancellation inside progress cannot miss the wakeup or launch", settings, async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = new Error("cancel from progress");
  await assert.rejects(waitForHerdrFinish({
    endpoint: "unused", paneId: "self", sessionRef: "session-self", scope: "tab", signal: controller.signal,
    progress: () => controller.abort(reason),
  }), (error: unknown) => error === reason);
  assert.ok(f.subscriptions.every((s) => s.closed));
});

test("synchronous prompt submission failure is reported after releasing the blocked hold", settings, async (t) => {
  const f = extensionFixture(t);
  f.state.panes.pop();
  f.uiState.sendError = new Error("submission rejected");
  await f.run("start-tab-finish", "ready immediately");
  await until(() => f.notifications.length > 0);
  assert.match(f.notifications.at(-1)!, /prompt submission failed.*submission rejected/);
  assert.deepEqual(f.blocks, [true, false]);
  assert.deepEqual(f.prompts, []);
  assert.equal(f.uiState.widget, undefined);
});

test("connection loss cleans the UI/blocked hold and reports an error without submitting", settings, async (t) => {
  const f = extensionFixture(t);
  await f.run("start-space-finish", "never send");
  await until(() => f.state.queries >= 2);
  f.subscriptions[0].failed(new Error("Herdr connection closed"));
  await until(() => f.notifications.length > 0);
  assert.match(f.notifications.at(-1)!, /wait failed.*connection closed/);
  assert.deepEqual(f.blocks, [true, false]);
  assert.deepEqual(f.prompts, []);
});
