import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDelegateAltController, delegateModelLabel, resolveDelegateModel, type DelegateModelPair } from "./delegate-alt.ts";

type Model = NonNullable<ExtensionContext["model"]>;
type Listener = (event: unknown, ctx: ExtensionCommandContext) => Promise<void>;
interface Command {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
  getArgumentCompletions(prefix: string): Array<{ value: string; label: string }>;
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-alt-test-"));
  const agentDir = path.join(root, "agent");
  const file = path.join(agentDir, "delegate-alt.json");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = { provider: "first-provider", id: "same-model" } as Model;
  const second = { provider: "second-provider", id: "same-model" } as Model;
  const third = { provider: "third-provider", id: "family/model" } as Model;
  const models = [first, second, third];
  const unauthenticated = new Set<string>();
  const notifications: Array<{ text: string; level: string }> = [];
  const messages: unknown[] = [];
  const selections: Array<{ title: string; labels: string[] }> = [];
  let picks: Array<string | undefined> = [];
  let current: Model | undefined = first;
  let hasUI = true;
  const ctx = {
    get model() { return current; },
    get hasUI() { return hasUI; },
    modelRegistry: {
      getAvailable: () => models.filter((model) => !unauthenticated.has(delegateModelLabel(model))),
    },
    ui: {
      notify: (text: string, level: string) => notifications.push({ text, level }),
      select: async (title: string, labels: string[]) => {
        selections.push({ title, labels });
        assert.ok(picks.length > 0, "unexpected picker");
        const selected = picks.shift();
        if (selected !== undefined) assert.ok(labels.includes(selected), `picker lacks ${selected}`);
        return selected;
      },
    },
  } as unknown as ExtensionCommandContext;

  function create() {
    let command: Command | undefined;
    const changes: Array<DelegateModelPair | null> = [];
    const events = new Map<string, Listener>();
    const pi = {
      registerCommand: (name: string, spec: Command) => {
        assert.equal(name, "delegate-alt");
        command = spec;
      },
      on: (name: string, listener: Listener) => events.set(name, listener),
      sendMessage: (message: unknown) => messages.push(message),
    } as unknown as ExtensionAPI;
    const controller = createDelegateAltController(pi, (pair) => changes.push(pair));
    assert.ok(command);
    return {
      controller, changes, command,
      run: (args: string) => command!.handler(args, ctx),
      emit: (name: string) => {
        const listener = events.get(name);
        assert.ok(listener, `missing ${name} handler`);
        return listener({}, ctx);
      },
    };
  }

  const pair: DelegateModelPair = [first, second];
  return {
    root, agentDir, file, ctx, first, second, third, pair, models, unauthenticated, notifications, messages, selections,
    pairArgs: pair.map(delegateModelLabel).join(" "),
    create,
    choose: (...values: Array<string | undefined>) => { picks = values; },
    setModel: (model: Model | undefined) => { current = model; },
    setHasUI: (value: boolean) => { hasUI = value; },
    writeConfig: (text: string) => {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(file, text);
    },
  };
}

test("absent optional configuration stays disabled without creating files or refreshing the tool", async (t) => {
  const f = fixture(t);
  const c = f.create();
  assert.deepEqual(c.changes, []);
  await c.emit("session_start");
  await c.emit("input");
  await c.run("status");
  assert.equal(c.controller.resolve(f.ctx, false), f.first);
  assert.throws(() => c.controller.resolve(f.ctx, true), /disabled.*\/delegate-alt/);
  await c.run("off");
  assert.deepEqual(c.changes, []);
  assert.equal(fs.existsSync(f.agentDir), false);
  assert.ok(f.notifications.every(({ text }) => /disabled/.test(text)));
  assert.deepEqual(c.command.getArgumentCompletions("o"), [{ value: "off", label: "off" }]);
  assert.deepEqual(c.command.getArgumentCompletions("sta"), [{ value: "status", label: "status" }]);
  assert.deepEqual(c.command.getArgumentCompletions("unknown"), []);
});

test("exact CLI pair persists privately, updates immediately, reports status, and off removes configuration", async (t) => {
  const f = fixture(t);
  const c = f.create();
  await c.run(`  ${f.pairArgs}  `);
  assert.deepEqual(c.changes, [f.pair]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { models: f.pair.map(delegateModelLabel) });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.agentDir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(f.agentDir), ["delegate-alt.json"], "atomic save leaves no temporary files");
  assert.equal(c.controller.resolve(f.ctx, true), f.second);
  await c.run(f.pairArgs);
  assert.equal(c.changes.length, 1, "unchanged configuration must not re-register the tool");
  await c.run("status");
  assert.match(f.notifications.at(-1)!.text, /enabled.*first-provider\/same-model.*second-provider\/same-model.*Saved globally/);
  assert.match(f.notifications.at(-1)!.text, /first model if the caller is outside the pair/);
  f.setModel(f.third);
  assert.equal(c.controller.resolve(f.ctx, true), f.first);
  assert.equal(c.controller.resolve(f.ctx, false), f.third);
  f.setModel(f.first);
  await c.run("off");
  assert.deepEqual(c.changes, [f.pair, null]);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(c.controller.resolve(f.ctx, false), f.first);
  assert.throws(() => c.controller.resolve(f.ctx, true), /disabled/);
});

test("picker selects a pair with distinct exact IDs and Disabled immediately removes it", async (t) => {
  const f = fixture(t);
  const c = f.create();
  f.choose("Choose model pair", delegateModelLabel(f.first), delegateModelLabel(f.third));
  await c.run("");
  assert.deepEqual(f.selections[0].labels, ["Disabled", "Choose model pair"]);
  assert.deepEqual(f.selections[1].labels, f.models.map(delegateModelLabel).sort());
  assert.deepEqual(f.selections[2].labels, [delegateModelLabel(f.second), delegateModelLabel(f.third)]);
  assert.deepEqual(c.changes, [[f.first, f.third]]);
  assert.equal(c.controller.resolve(f.ctx, true), f.third, "model IDs containing slashes must round-trip exactly");
  f.choose("Disabled");
  await c.run("");
  assert.deepEqual(c.changes, [[f.first, f.third], null]);
  assert.equal(fs.existsSync(f.file), false);
});

test("cancelling each picker stage preserves the configured pair and file", async (t) => {
  const f = fixture(t);
  const c = f.create();
  await c.run(f.pairArgs);
  const before = fs.readFileSync(f.file, "utf8");
  for (const choices of [
    [undefined],
    ["Choose model pair", undefined],
    ["Choose model pair", delegateModelLabel(f.third), undefined],
  ]) {
    f.choose(...choices);
    await c.run("");
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
    assert.deepEqual(c.changes, [f.pair]);
    assert.equal(c.controller.resolve(f.ctx, true), f.second);
  }
});

test("invalid, duplicate, missing, and unauthenticated CLI pairs leave existing configuration untouched", async (t) => {
  const f = fixture(t);
  const c = f.create();
  await c.run(f.pairArgs);
  const before = fs.readFileSync(f.file, "utf8");
  f.unauthenticated.add(delegateModelLabel(f.third));
  for (const args of [
    "one", "one two three", "one two", "/model provider/model", "provider/ provider/model",
    `${delegateModelLabel(f.first)} ${delegateModelLabel(f.first)}`,
    `${delegateModelLabel(f.first)} unknown/model`,
    `${delegateModelLabel(f.first)} ${delegateModelLabel(f.third)}`,
    "first-provider/* second-provider/*",
  ]) {
    await assert.rejects(c.run(args), /Usage|exact provider\/model|distinct models|Model unavailable/);
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
    assert.deepEqual(c.changes, [f.pair]);
  }
});

test("pair selection refuses provider-prefixed model IDs that Pi's child CLI interprets ambiguously", async (t) => {
  const f = fixture(t);
  const c = f.create();
  await c.run(f.pairArgs);
  const before = fs.readFileSync(f.file, "utf8");
  f.models.push({ ...f.third, id: "third-provider/review" });
  await assert.rejects(c.run(`${delegateModelLabel(f.first)} third-provider/third-provider/review`), /provider prefix ambiguously/);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.deepEqual(c.changes, [f.pair]);
});

test("picker refuses fewer than two authenticated models without creating configuration", async (t) => {
  const f = fixture(t);
  const c = f.create();
  f.unauthenticated.add(delegateModelLabel(f.second));
  f.unauthenticated.add(delegateModelLabel(f.third));
  f.choose("Choose model pair");
  await assert.rejects(c.run(""), /At least two authenticated models/);
  assert.deepEqual(c.changes, []);
  assert.equal(fs.existsSync(f.agentDir), false);
});

test("new controller restores global configuration on session_start and input observes external removal", async (t) => {
  const f = fixture(t);
  const first = f.create();
  await first.run(f.pairArgs);
  const second = f.create();
  assert.deepEqual(second.changes, [], "factory performs no global configuration read");
  await second.emit("session_start");
  assert.deepEqual(second.changes, [f.pair]);
  assert.equal(second.controller.resolve(f.ctx, true), f.second);
  fs.rmSync(f.file);
  await second.emit("input");
  assert.deepEqual(second.changes, [f.pair, null]);
  await second.emit("input");
  assert.equal(second.changes.length, 2);
  assert.throws(() => first.controller.resolve(f.ctx, true), /disabled/, "execution must refresh stale configuration too");
  assert.deepEqual(first.changes, [f.pair, null]);
  f.writeConfig(JSON.stringify({ models: [delegateModelLabel(f.first), delegateModelLabel(f.third)] }));
  await second.emit("input");
  assert.deepEqual(second.changes.at(-1), [f.first, f.third]);
});

test("malformed configuration disables the option and deduplicates diagnostics until recovery", async (t) => {
  const f = fixture(t);
  const c = f.create();
  await c.run(f.pairArgs);
  f.writeConfig("not json");
  await c.emit("input");
  assert.deepEqual(c.changes, [f.pair, null]);
  const errors = () => f.notifications.filter(({ level }) => level === "error");
  assert.equal(errors().length, 1);
  assert.ok(errors()[0].text.includes(f.file));
  await c.emit("input");
  assert.equal(c.controller.resolve(f.ctx, false), f.first, "bad optional config must not prevent ordinary delegation");
  assert.throws(() => c.controller.resolve(f.ctx, true), /invalid configuration/);
  assert.equal(errors().length, 1);
  await c.run(f.pairArgs);
  assert.deepEqual(c.changes, [f.pair, null, f.pair]);
  f.writeConfig("not json");
  await c.emit("input");
  assert.equal(errors().length, 2, "a new failure after recovery should be reported");
  await c.run("off");
  assert.equal(fs.existsSync(f.file), false, "off must repair invalid configuration");
});

test("configuration shape requires exactly two distinct exact identifiers", async (t) => {
  const f = fixture(t);
  const c = f.create();
  for (const value of [
    null, {}, [], { models: [] }, { models: [delegateModelLabel(f.first)] },
    { models: f.models.map(delegateModelLabel) },
    { models: [delegateModelLabel(f.first), delegateModelLabel(f.first)] },
    { models: [1, delegateModelLabel(f.second)] },
    { models: ["provider/model with space", delegateModelLabel(f.second)] },
  ]) {
    f.writeConfig(JSON.stringify(value));
    await c.emit("input");
    assert.throws(() => c.controller.resolve(f.ctx, true), /invalid configuration/);
    assert.equal(c.controller.resolve(f.ctx, false), f.first);
    assert.deepEqual(c.changes, []);
  }
});

test("non-UI status uses a session message and explicit commands do not require a picker", async (t) => {
  const f = fixture(t);
  const c = f.create();
  f.setHasUI(false);
  await c.run("status");
  assert.equal(f.messages.length, 1);
  const status = f.messages[0] as { customType: string; content: string; display: boolean };
  assert.equal(status.customType, "pi-orchestration:delegate-alt-status");
  assert.equal(status.display, true);
  assert.match(status.content, /disabled/);
  for (const tool of ["do", "delegate", "fresh_look"]) assert.ok(status.content.includes(tool));
  assert.match(status.content, /no alt parameter/);
  await c.run(f.pairArgs);
  assert.equal(c.controller.resolve(f.ctx, true), f.second);
  await assert.rejects(c.run(""), /Usage/);
  await c.run("off");
  assert.equal(f.selections.length, 0);
  assert.equal(fs.existsSync(f.file), false);
});

test("model resolution alternates pair members, selects the first for outsiders, and otherwise inherits the caller", (t) => {
  const f = fixture(t);
  assert.equal(resolveDelegateModel(f.ctx, f.pair, true), f.second);
  assert.equal(resolveDelegateModel(f.ctx, f.pair, false), f.first);
  assert.equal(resolveDelegateModel(f.ctx, null, false), f.first);
  assert.equal(f.ctx.model, f.first, "resolution must never change the parent model");
  f.setModel(f.second);
  assert.equal(resolveDelegateModel(f.ctx, f.pair, true), f.first);
  assert.equal(f.ctx.model, f.second);
  f.setModel(f.third);
  assert.equal(resolveDelegateModel(f.ctx, f.pair, false), f.third);
  assert.equal(resolveDelegateModel(f.ctx, f.pair, true), f.first);
  assert.equal(resolveDelegateModel(f.ctx, [f.second, f.first], true), f.second, "fallback follows configured order");
  assert.equal(f.ctx.model, f.third);
  f.setModel(f.first);
  assert.throws(() => resolveDelegateModel(f.ctx, null, true), /disabled/);
  f.unauthenticated.add(delegateModelLabel(f.second));
  assert.throws(() => resolveDelegateModel(f.ctx, f.pair, true), /model unavailable.*second-provider\/same-model/);
  assert.equal(resolveDelegateModel(f.ctx, f.pair, false), f.first);
  f.unauthenticated.clear();
  f.models.splice(f.models.indexOf(f.second), 1);
  assert.throws(() => resolveDelegateModel(f.ctx, f.pair, true), /model unavailable/);
  f.setModel(f.third);
  assert.equal(resolveDelegateModel(f.ctx, f.pair, true), f.first, "unselected model availability must not affect fallback");
  assert.throws(() => resolveDelegateModel(f.ctx, null, true), /disabled/);
  f.models.push(f.second);
  f.unauthenticated.add(delegateModelLabel(f.first));
  assert.throws(() => resolveDelegateModel(f.ctx, f.pair, true), /model unavailable.*first-provider\/same-model/);
  assert.equal(resolveDelegateModel(f.ctx, f.pair, false), f.third);
  f.unauthenticated.clear();
  f.models.splice(f.models.indexOf(f.first), 1);
  assert.throws(() => resolveDelegateModel(f.ctx, f.pair, true), /model unavailable.*first-provider\/same-model/);
  f.setModel(undefined);
  assert.throws(() => resolveDelegateModel(f.ctx, f.pair, false), /no selected model/);
  assert.throws(() => resolveDelegateModel(f.ctx, f.pair, true), /no selected model/);
});
