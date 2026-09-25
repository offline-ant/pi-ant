import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative } from "node:path";
import test, { type TestContext } from "node:test";
import {
  loadProjectContextFiles,
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import agentsD, { buildAgentsDContext } from "./agents-d.ts";

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "agents-d-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("inherits all ancestors in Pi's order across repository boundaries, retaining duplicate basenames", (t) => {
  const root = fixture(t);
  const repo = join(root, "repo");
  const cwd = join(repo, "nested", "project");
  mkdirSync(join(repo, ".git"), { recursive: true });
  for (const [index, dir] of [root, repo, cwd].entries()) {
    put(join(dir, "AGENTS.md"), `scope-${index}`);
    put(join(dir, "AGENTS.d", "rules.md"), `scope-${index}`);
    put(join(dir, "AGENTS.d", "a.md"), `first-${index}`);
  }
  const result = buildAgentsDContext(cwd);
  assert.ok(result);
  const piScopes = loadProjectContextFiles({ cwd, agentDir: join(root, "global") })
    .filter((file) => file.path.startsWith(`${root}/`))
    .map((file) => dirname(file.path));
  assert.deepEqual(piScopes, [root, repo, cwd]);
  assert.deepEqual(result.loadedFiles.filter((file) => file.endsWith("rules.md")),
    piScopes.map((dir) => relative(cwd, join(dir, "AGENTS.d", "rules.md"))));
  for (let index = 0; index < 3; index++) {
    assert.ok(result.promptSection.indexOf(`first-${index}`) < result.promptSection.indexOf(`scope-${index}`));
    if (index > 0) {
      assert.ok(result.promptSection.indexOf(`scope-${index - 1}`) < result.promptSection.indexOf(`scope-${index}`));
    }
  }
  assert.ok(result.promptSection.includes('<file path="../../../AGENTS.d/rules.md">'));
  assert.ok(result.promptSection.includes("../../../AGENTS.d/\n"));
  assert.ok(result.promptSection.includes('<file path="AGENTS.d/rules.md">'));
});

test("inherits parent-only context across missing and non-directory AGENTS.d entries", (t) => {
  const root = fixture(t);
  const cwd = join(root, "file", "missing", "cwd");
  mkdirSync(cwd, { recursive: true });
  put(join(root, "AGENTS.d", "parent.md"), "inherited-parent");
  put(join(root, "file", "AGENTS.d"), "not a directory");
  const result = buildAgentsDContext(cwd);
  assert.ok(result);
  assert.ok(result.promptSection.includes("inherited-parent"));
  assert.ok(result.loadedFiles.includes("../../../AGENTS.d/parent.md"));
  assert.equal(result.promptSection.includes("not a directory"), false);
});

test("preserves top-level loading, tree-only descendants, symlinks and cycle handling in inherited directories", (t) => {
  const root = fixture(t);
  const cwd = join(root, "child");
  const directory = join(root, "AGENTS.d");
  mkdirSync(cwd);
  put(join(directory, "nested", "hidden.md"), "nested-content-must-not-load");
  put(join(root, "target.md"), "linked-content");
  symlinkSync(join(root, "target.md"), join(directory, "linked.md"));
  symlinkSync(join(root, "absent.md"), join(directory, "dangling.md"));
  symlinkSync(directory, join(directory, "loop"));
  const result = buildAgentsDContext(cwd);
  assert.ok(result);
  assert.ok(result.promptSection.includes(`<file path="../AGENTS.d/linked.md" realpath="${realpathSync(join(root, "target.md"))}">\nlinked-content</file>`));
  assert.ok(result.promptSection.includes("hidden.md"));
  assert.ok(result.promptSection.includes("dangling.md"));
  assert.ok(result.promptSection.includes("loop/ →"));
  assert.equal(result.promptSection.includes("nested-content-must-not-load"), false);
  assert.equal(result.loadedFiles.includes("../AGENTS.d/dangling.md"), false);
  assert.ok(result.visibleDirs.includes("../AGENTS.d/nested/"));
});

test("normalizes relative cwd and follows lexical ancestors for symlinked cwd like Pi", (t) => {
  const root = fixture(t);
  const logical = join(root, "logical");
  const physical = join(root, "physical");
  const cwd = join(logical, "linked");
  mkdirSync(logical);
  mkdirSync(join(physical, "child"), { recursive: true });
  put(join(logical, "AGENTS.d", "logical.md"), "logical-parent");
  put(join(physical, "AGENTS.d", "physical.md"), "physical-parent");
  symlinkSync(join(physical, "child"), cwd);
  const result = buildAgentsDContext(cwd);
  assert.ok(result);
  assert.ok(result.promptSection.includes("logical-parent"));
  assert.equal(result.promptSection.includes("physical-parent"), false);
  assert.deepEqual(buildAgentsDContext(relative(process.cwd(), cwd)), result);
});

test("filesystem-root cwd terminates without loading it twice", () => {
  const result = buildAgentsDContext(parse(process.cwd()).root);
  if (result) {
    assert.equal(result.promptSection.split("# AGENTS.d context").length, 2);
    assert.ok(result.loadedFiles.every((file) => file.startsWith("AGENTS.d/")));
  }
});

test("before_agent_start rescans inherited files and cwd without replacing unrelated sections", async (t) => {
  const root = fixture(t);
  const cwd = join(root, "child");
  mkdirSync(cwd);
  const baseline = buildAgentsDContext(cwd)?.promptSection;
  let handler: ((event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown) | undefined;
  agentsD({
    on: ((name: string, callback: typeof handler) => {
      assert.equal(name, "before_agent_start");
      handler = callback;
    }) as ExtensionAPI["on"],
  } as ExtensionAPI);
  assert.ok(handler);
  const notifications: string[] = [];
  const ctx = { cwd, ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext;
  const run = async () => {
    const event = { systemPromptOptions: { sections: { other: "preserved" } } } as unknown as BeforeAgentStartEvent;
    await handler!(event, ctx);
    assert.equal(event.systemPromptOptions.sections.other, "preserved");
    return event.systemPromptOptions.sections.agents_d;
  };
  assert.equal(await run(), baseline);
  put(join(root, "AGENTS.d", "rules.md"), "original-content");
  assert.ok((await run())?.includes("original-content"));
  assert.ok(notifications.at(-1)?.includes("../AGENTS.d/rules.md"));
  put(join(root, "AGENTS.d", "rules.md"), "changed-content");
  assert.ok((await run())?.includes("changed-content"));
  ctx.cwd = root;
  assert.ok((await run())?.includes('<file path="AGENTS.d/rules.md">'));
  rmSync(join(root, "AGENTS.d"), { recursive: true });
  ctx.cwd = cwd;
  assert.equal(await run(), baseline);
});
