import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import lints from "./lints.ts";

type ToolResult = { details?: { lintWarnings?: { source: string; diagnostics: string[] }[] } } | undefined;
type Handler = (event: unknown, ctx: { cwd: string }) => Promise<ToolResult>;
type Tool = { name: string; promptGuidelines?: string[] };

function extension(): { toolResult: Handler; tools: Map<string, Tool> } {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  lints({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
  } as unknown as Parameters<typeof lints>[0]);
  return { toolResult: handlers.get("tool_result")!, tools };
}

/** A directory with a `uv` that selects `python`, standing in for a synced script environment. */
function workspace(t: TestContext, python: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-lints-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "uv"), `#!/bin/sh\necho '${python}'\n`);
  chmodSync(join(bin, "uv"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function lint(dir: string, name: string, text: string): Promise<ToolResult> {
  const path = join(dir, name);
  writeFileSync(path, text);
  return extension().toolResult({ toolName: "write", input: { path }, content: [], details: undefined, isError: false }, { cwd: dir });
}

const SCRIPT = `# /// script
# dependencies = ["fakedep"]
# ///
import fakedep

print(fakedep.VALUE)
`;

test("a PEP 723 script is checked in the environment uv selects for it", async (t) => {
  const dir = workspace(t, "");
  const environment = join(dir, "environment");
  assert.equal(spawnSync("uv", ["venv", "--quiet", environment], { env: { ...process.env, PATH: process.env.PATH!.split(":").slice(1).join(":") } }).status, 0);
  const lib = join(environment, "lib");
  writeFileSync(join(lib, readdirSync(lib)[0], "site-packages", "fakedep.py"), "VALUE = 1\n");
  writeFileSync(join(dir, "bin", "uv"), `#!/bin/sh\necho '${join(environment, "bin", "python")}'\n`);

  assert.equal(await lint(dir, "script.py", SCRIPT), undefined);
});

test("an unresolved import explains how to expose it to ty", async (t) => {
  const dir = workspace(t, "");
  for (const [name, text] of [["script.py", SCRIPT], ["plain.py", "import fakedep\n"]]) {
    const warning = (await lint(dir, name, text))?.details?.lintWarnings?.[0];
    assert.equal(warning?.source, "python-ty");
    const hint = warning!.diagnostics.at(-1)!;
    assert.match(hint, new RegExp(`uv sync --script ${join(dir, name)}`));
    assert.match(hint, /ty\.toml/);
  }
});

test("other ty errors carry no import hint", async (t) => {
  const dir = workspace(t, "");
  const warning = (await lint(dir, "typed.py", 'value: int = "text"\n'))?.details?.lintWarnings?.[0];
  assert.equal(warning?.source, "python-ty");
  assert.doesNotMatch(warning!.diagnostics.join("\n"), /ty\.toml/);
});

test("the edit tool steers file changes away from bash", () => {
  const guidelines = extension().tools.get("edit")?.promptGuidelines ?? [];
  assert.ok(guidelines.includes("Edit files with edit/write, not bash; only those are linted."));
  assert.ok(guidelines.length > 1);
});
