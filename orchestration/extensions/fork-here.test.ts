import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TOOL_CONTROL_STATE_TYPE } from "../../extensions/tool-control-state.ts";
import { flushSessionFile } from "../context.ts";
import { forkFixture } from "../test/fork-fixture.ts";
import { claimName, readPersistentWorker, readTarget, savePersistentWorker, saveTarget, tryClaimName } from "../workers.ts";
import type { HostTarget } from "../host-types.ts";
import forkHereExtension, { forkHere, parseForkArgs } from "./fork-here.ts";

const args = ["--provider", "fixture", "--model", "fake", "--thinking", "high"];

test("fork argument parsing preserves optional cwd and prompt text", () => {
  assert.deepEqual(parseForkArgs(""), { name: undefined, folder: undefined, prompt: undefined });
  assert.deepEqual(parseForkArgs("named '/tmp/a b' -- explain 'this'\nand that"), { name: "named", folder: "/tmp/a b", prompt: "explain 'this'\nand that" });
  assert.deepEqual(parseForkArgs("-- discuss"), { name: undefined, folder: undefined, prompt: "discuss" });
  assert.throws(() => parseForkArgs("one two three"), /Usage/);
  assert.throws(() => parseForkArgs("Bad"), /Name/);
  assert.throws(() => parseForkArgs("name 'folder"), /Unclosed/);
  assert.throws(() => parseForkArgs("name --unknown"), /Unknown/);
});

test("idle and prompted forks use explicit parent, actual branch and exact tools without touching parent", async () => {
  const fixture = forkFixture();
  try {
    const branch = fixture.session.getLeafId();
    fixture.session.appendMessage({ role: "user", content: "Excluded branch", timestamp: Date.now() });
    fixture.session.branch(branch!);
    flushSessionFile(fixture.session, fixture.sessionFile);
    const bytes = fs.readFileSync(fixture.sessionFile, "utf8");
    const name = `fork-test-${process.pid}`;
    const result = await forkHere(fixture.pi, { name }, fixture.directory, fixture.session, args);
    fixture.targets.push(result.name);
    assert.equal(fixture.prompts.length, 0);
    assert.equal(readTarget(name)?.id, result.target.id);
    assert.equal(fixture.session.getLeafId(), branch);
    assert.equal(fs.readFileSync(fixture.sessionFile, "utf8"), bytes);
    const child = SessionManager.open(result.sessionFile);
    assert.equal(child.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user" && entry.message.content === "Excluded branch"), false);
    const tools = child.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === TOOL_CONTROL_STATE_TYPE);
    assert.ok(tools?.type === "custom");
    assert.deepEqual((tools.data as { enabledTools: string[] }).enabledTools, fixture.pi.getActiveTools());
    const startup = fixture.commands.find((command) => command.includes("split-window"))!;
    assert.equal(startup[startup.indexOf("-t") + 1], "%901");
    assert.ok(startup.at(-1)?.includes("'--provider' 'fixture' '--model' 'fake' '--thinking' 'high'"));
    assert.ok(!fixture.commands.some((command) => command.includes("send-keys")), "must not inject terminal text into a draft");

    const folder = path.join(fixture.directory, "another");
    fs.mkdirSync(folder);
    const prompted = await forkHere(fixture.pi, { name: `${name}-next`, folder, prompt: "Discuss\nwithout changing my draft" }, fixture.directory, fixture.session, args);
    fixture.targets.push(prompted.name);
    assert.deepEqual(fixture.prompts, ["Discuss\nwithout changing my draft"]);
    assert.equal(SessionManager.open(prompted.sessionFile).getCwd(), folder);
    assert.equal(fs.readFileSync(fixture.sessionFile, "utf8"), bytes);
    await assert.rejects(forkHere(fixture.pi, { name }, fixture.directory, fixture.session, args), /already exists/);
    assert.equal(readTarget(name)?.id, result.target.id);

    process.env.TMUX_PANE = prompted.target.id;
    const nested = await forkHere(fixture.pi, { name: `${name}-nested` }, folder, SessionManager.open(prompted.sessionFile), args);
    fixture.targets.push(nested.name);
    const nestedStartup = fixture.commands.findLast((command) => command.includes("split-window"))!;
    assert.equal(nestedStartup[nestedStartup.indexOf("-t") + 1], prompted.target.id);
    assert.equal(SessionManager.open(nested.sessionFile).getHeader()?.parentSession, prompted.sessionFile);
  } finally { await fixture.cleanup(); }
});

test("concurrent unnamed forks reserve different names without changing the parent", async () => {
  const fixture = forkFixture();
  try {
    const bytes = fs.readFileSync(fixture.sessionFile, "utf8");
    const leaf = fixture.session.getLeafId();
    const forks = await Promise.all(Array.from({ length: 3 }, async () => {
      const result = await forkHere(fixture.pi, {}, fixture.directory, fixture.session, args);
      fixture.targets.push(result.name);
      return result;
    }));
    assert.equal(new Set(forks.map((fork) => fork.name)).size, 3);
    assert.equal(new Set(forks.map((fork) => fork.target.id)).size, 3);
    for (const fork of forks) {
      assert.deepEqual(readTarget(fork.name), fork.target);
      claimName(fork.name)();
    }
    assert.equal(fs.readFileSync(fixture.sessionFile, "utf8"), bytes);
    assert.equal(fixture.session.getLeafId(), leaf);
  } finally { await fixture.cleanup(); }
});

test("exited panels, persistent workers and forks retain their registered names", async () => {
  const fixture = forkFixture();
  try {
    for (const [index, kind] of ["shell", "worker", "fork"].entries()) {
      // Reserve the lowest currently available automatic name without touching
      // another test's or user's registration or in-progress claim.
      let name = "";
      for (let number = 1; ; number++) {
        const candidate = `fork-${number}`;
        const release = tryClaimName(candidate);
        if (!release) continue;
        try {
          if (readTarget(candidate)) continue;
          name = candidate;
          const target: HostTarget = {
            host: "tmux", endpoint: "/tmp/pi-fork-fake-tmux", id: `%${980 + index}`,
            name, kind: kind === "shell" ? "shell" : "pi",
          };
          fixture.exitedPanes.add(target.id);
          fixture.targets.push(name);
          if (kind === "worker") {
            savePersistentWorker({ target, cwd: fixture.directory, sessionFile: fixture.sessionFile, statusPath: path.join(fixture.directory, "status.json") });
          } else saveTarget(target);
          break;
        } finally { release(); }
      }
      const registered = readTarget(name);
      const worker = kind === "worker" ? readPersistentWorker(name) : undefined;
      const before = fixture.commands.length;
      await assert.rejects(forkHere(fixture.pi, { name }, fixture.directory, fixture.session, args), /already exists/);
      assert.equal(fixture.commands.length, before, "reserved names must not inspect or close native targets");
      assert.deepEqual(readTarget(name), registered);
      if (kind === "worker") assert.deepEqual(readPersistentWorker(name), worker);
      const automatic = await forkHere(fixture.pi, {}, fixture.directory, fixture.session, args);
      fixture.targets.push(automatic.name);
      assert.notEqual(automatic.name, name);
      assert.deepEqual(readTarget(name), registered);
      assert.ok(!fixture.commands.some((command) => command.includes("kill-pane")));
      claimName(name)();
    }
  } finally { await fixture.cleanup(); }
});

test("failed startup and cancellation release the name without altering parent", async () => {
  const fixture = forkFixture();
  try {
    const name = `fork-fail-${process.pid}`;
    fixture.failStart("native startup failed");
    await assert.rejects(forkHere(fixture.pi, { name }, fixture.directory, fixture.session, args), /native startup failed/);
    assert.equal(readTarget(name), undefined);
    claimName(name)();
    for (const child of fixture.children) assert.equal(fs.existsSync(child), false);
    const controller = new AbortController();
    controller.abort();
    const count = fixture.commands.length;
    await assert.rejects(forkHere(fixture.pi, { name }, fixture.directory, fixture.session, args, controller.signal), /abort/i);
    assert.equal(fixture.commands.length, count);
  } finally { await fixture.cleanup(); }
});

test("fork shortcut leaves an unsent draft and session unchanged; busy shortcut refuses", async () => {
  const fixture = forkFixture();
  type Handler = (args: unknown, ctx?: unknown) => Promise<void>;
  const commands = new Map<string, Handler>();
  const shortcuts = new Map<string, Handler>();
  Object.assign(fixture.pi, {
    on: () => undefined,
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command.handler),
    registerShortcut: (name: string, command: { handler: Handler }) => shortcuts.set(name, command.handler),
  });
  forkHereExtension(fixture.pi);
  let idle = true;
  const draft = "my unsent parent draft";
  const ctx = {
    cwd: fixture.directory,
    sessionManager: fixture.session,
    model: { provider: "fixture", id: "fake" },
    isIdle: () => idle, hasPendingMessages: () => false,
    ui: {
      getEditorText: () => draft,
      setEditorText: () => assert.fail("fork modified draft"),
      notify: (text: string) => { if (text.startsWith("Started ")) fixture.targets.push(text.slice(8, -1)); },
    },
  };
  try {
    assert.deepEqual([...commands.keys()], ["fork-here"]);
    const parent = fs.readFileSync(fixture.sessionFile, "utf8");
    await shortcuts.get("ctrl+alt+f")!(ctx);
    assert.equal(fixture.targets.length, 1);
    assert.equal(ctx.ui.getEditorText(), draft);
    assert.equal(fs.readFileSync(fixture.sessionFile, "utf8"), parent);
    idle = false;
    const count = fixture.commands.length;
    await shortcuts.get("ctrl+alt+f")!(ctx);
    assert.equal(fixture.commands.length, count);
  } finally { await fixture.cleanup(); }
});
