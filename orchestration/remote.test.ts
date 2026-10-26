import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Skill, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyRemotePrompt, loadRemoteContext } from "./remote-context.ts";
import { parseRemoteTarget, RemoteSession, resolveRemoteLocation } from "./remote-session.ts";
import { createRemoteToolDefinitions, remoteUserBashOperations } from "./remote-tools.ts";
import { remoteCommand, remoteTerminalArgv } from "./ssh.ts";
import { installSshStub } from "./test/ssh-stub.ts";

type AnyTool = ToolDefinition<any, any, any>;
type ToolContext = Parameters<AnyTool["execute"]>[4];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tools(remote: RemoteSession, localCwd: string) {
  const definitions = new Map(createRemoteToolDefinitions(remote, localCwd).map((tool) => [tool.name, tool]));
  const ctx = { cwd: localCwd, model: undefined } as unknown as ToolContext;
  return (name: string, params: Record<string, unknown>, options: { signal?: AbortSignal; onText?: (text: string) => void } = {}) =>
    definitions.get(name)!.execute(`call-${name}`, params, options.signal,
      (update) => options.onText?.(text(update)), ctx) as Promise<{ content: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean }>;
}

test("targets parse destination and optional absolute path", async () => {
  assert.deepEqual(parseRemoteTarget("user@host"), { destination: "user@host" });
  assert.deepEqual(parseRemoteTarget("user@host:/srv/app"), { destination: "user@host", path: "/srv/app" });
  assert.deepEqual(parseRemoteTarget("alias:~/work"), { destination: "alias", path: "~/work" });
  assert.deepEqual(parseRemoteTarget("user@[::1]:/x"), { destination: "user@[::1]", path: "/x" });
  assert.deepEqual(parseRemoteTarget("host:"), { destination: "host" });
  assert.throws(() => parseRemoteTarget("host:relative"), /absolute/);
  assert.throws(() => parseRemoteTarget("-oProxyCommand=x"), /Invalid SSH destination/);
  assert.throws(() => parseRemoteTarget("a b"), /Invalid SSH destination/);
  await assert.rejects(new RemoteSession("-bad").location(), /PI_REMOTE is invalid: Invalid SSH destination/);
});

test("remote commands avoid login-shell syntax; panels get a tty at the remote directory", () => {
  const command = remoteCommand("echo \"it's\" $HOME `x` \\ !");
  assert.match(command, /^exec bash -c 'eval "\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\)"'$/);
  assert.throws(() => remoteCommand("x".repeat(100_000)), /too large/);
  const argv = remoteTerminalArgv("me@box", "/srv/it's", "fish");
  assert.equal(argv[0], "ssh");
  assert.ok(argv.includes("BatchMode=yes") && argv.some((arg) => arg.startsWith("ControlPath=")));
  assert.deepEqual(argv.slice(-3, -1), ["-t", "me@box"]);
  const script = Buffer.from(/printf %s (\S+)/.exec(argv.at(-1)!)![1]!, "base64").toString();
  assert.equal(script, "cd -- '/srv/it'\\''s' || exit 1\nexec bash -l -c 'fish'");
});

test("locations resolve home, paths and folders remotely; failures are explicit", async (t) => {
  const stub = installSshStub(t);
  fs.mkdirSync(path.join(stub.home, "proj", "sub"), { recursive: true });
  assert.deepEqual(await resolveRemoteLocation({ destination: "box" }), { destination: "box", cwd: stub.home, home: stub.home });
  assert.equal((await resolveRemoteLocation({ destination: "box", path: "~/proj" }, "sub")).cwd, path.join(stub.home, "proj", "sub"));
  assert.equal((await resolveRemoteLocation({ destination: "box", path: path.join(stub.home, "proj") }, "../proj")).cwd, path.join(stub.home, "proj"));
  await assert.rejects(resolveRemoteLocation({ destination: "box" }, "missing"), /box:~ \+ missing is not accessible/);
  await assert.rejects(resolveRemoteLocation({ destination: "down" }), /SSH connection to down failed: ssh: connect to host down port 22: Connection refused/);
});

test("file tools read, write, edit, list and find on the remote target", async (t) => {
  const stub = installSshStub(t);
  const cwd = path.join(stub.home, "proj");
  fs.mkdirSync(path.join(cwd, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "deep", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(cwd, ".hidden"), "");
  fs.writeFileSync(path.join(cwd, "image.png"), PNG);
  const local = path.join(stub.root, "local");
  fs.mkdirSync(local);
  const run = tools(new RemoteSession(`box:${cwd}`), local);

  const content = "line 1\nquotes ' \" $(echo no) `no` \\ ü\u0000end\n";
  await run("write", { path: "notes/new.txt", content });
  assert.equal(fs.readFileSync(path.join(cwd, "notes", "new.txt"), "utf8"), content, "relative paths resolve remotely; content is byte-exact");
  assert.ok(!fs.existsSync(path.join(local, "notes")), "nothing is written locally");

  assert.match(text(await run("read", { path: "notes/new.txt", offset: 2 })), /^quotes ' " \$\(echo no\)/);
  fs.writeFileSync(path.join(stub.home, "top.txt"), "home file\n");
  assert.match(text(await run("read", { path: "~/top.txt" })), /home file/, "~ is the remote home");
  const image = await run("read", { path: "image.png" });
  assert.equal(image.content.find((item) => item.type === "image")?.mimeType, "image/png");
  await assert.rejects(run("read", { path: "missing.txt" }), /ENOENT: cannot read box:.*missing\.txt/);

  await run("edit", { path: "src/deep/a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] });
  assert.equal(fs.readFileSync(path.join(cwd, "src", "deep", "a.ts"), "utf8"), "export const a = 2;\n");
  await assert.rejects(run("edit", { path: "nope.ts", edits: [{ oldText: "x", newText: "y" }] }), /Could not edit file: nope\.ts\. Error code: ENOENT/);

  const before = stub.scripts().length;
  assert.deepEqual(text(await run("ls", {})).split("\n"), [".hidden", "image.png", "notes/", "src/"]);
  assert.equal(stub.scripts().length - before, 2, "one probe and one listing, no per-entry round trips");

  assert.equal(text(await run("find", { pattern: "*.ts" })), "src/deep/a.ts");
  assert.equal(text(await run("find", { pattern: "deep/*.ts" })), "src/deep/a.ts");
  await assert.rejects(run("grep", { pattern: "x" }), /grep runs ripgrep on this machine .* Use rg through bash/);
});

test("bash streams remotely, reports status, and stops the remote process group", async (t) => {
  const stub = installSshStub(t);
  const run = tools(new RemoteSession(`box:${stub.home}`), stub.root);

  const ok = await run("bash", { command: "pwd; echo err >&2" });
  assert.equal(text(ok), `${stub.home}\nerr\n`);
  const failed = await run("bash", { command: "echo out; exit 3" });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /out\n+Command exited with code 3/);

  const started = Date.now();
  assert.equal(text(await run("bash", { command: "(sleep 5; echo late) & echo done" })), "done\n");
  assert.ok(Date.now() - started < 3000, "background descendants holding stdout do not block the result");

  await assert.rejects(run("bash", { command: "sleep 30", timeout: 1 }), /Command timed out after 1 seconds/);

  const controller = new AbortController();
  const pidFile = path.join(stub.home, "pids");
  let seen = "";
  const pending = run("bash", { command: `sleep 60 & echo "$! $$" > ${pidFile}; echo started; sleep 60` }, {
    signal: controller.signal,
    onText: (output) => { seen = output; if (output.includes("started")) controller.abort(); },
  });
  await assert.rejects(pending, /Command aborted/);
  assert.match(seen, /started/);
  const pids = fs.readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
  for (let attempt = 0; attempt < 40 && pids.some(alive); attempt++) await delay(100);
  assert.deepEqual(pids.filter(alive), [], "background and foreground remote processes are terminated");

  const output: string[] = [];
  const user = await remoteUserBashOperations(new RemoteSession(`box:${stub.home}`)).exec("pwd", "/local/ignored", { onData: (data) => output.push(data.toString()) });
  assert.equal(user.exitCode, 0);
  assert.equal(output.join(""), `${stub.home}\n`, "! commands run in the remote cwd");

  const truncated = await run("bash", { command: "seq 1 5000" });
  const fullOutput = /Full output: (\S+)\]/.exec(text(truncated))?.[1];
  assert.ok(fullOutput);
  assert.ok(stub.scripts().some(({ script }) => script.includes(`cat > '${fullOutput}'`)), "full output is copied to the same remote path");

  await assert.rejects(tools(new RemoteSession("down:/x"), stub.root)("bash", { command: "true" }), /SSH connection to down failed/);
  await assert.rejects(tools(new RemoteSession(`box:${path.join(stub.home, "gone")}`), stub.root)("read", { path: "x" }), /is not accessible/);
});

test("remote project context replaces local project files and skills", async (t) => {
  const stub = installSshStub(t);
  const root = path.join(stub.home, "repo");
  const cwd = path.join(root, "a", "b");
  fs.mkdirSync(path.join(cwd, "AGENTS.d", "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "root rules");
  fs.writeFileSync(path.join(root, "a", "CLAUDE.md"), "middle rules");
  fs.writeFileSync(path.join(root, "a", "AGENTS.md"), "preferred middle rules");
  fs.writeFileSync(path.join(cwd, "AGENTS.d", "notes.md"), "note body\n");
  fs.writeFileSync(path.join(cwd, "AGENTS.d", "sub", "deep.md"), "not loaded");
  const location = { destination: "box", cwd, home: stub.home };
  const context = await loadRemoteContext(location);
  const ours = context.contextFiles.filter((file) => file.path.startsWith(root));
  assert.deepEqual(ours, [
    { path: path.join(root, "AGENTS.md"), content: "root rules" },
    { path: path.join(root, "a", "AGENTS.md"), content: "preferred middle rules" },
  ]);

  const options = {
    cwd: "/local/project",
    contextFiles: [
      { path: "/home/me/.pi/agent/AGENTS.md", content: "global" },
      { path: "/local/AGENTS.md", content: "local ancestor" },
      { path: "/local/project/AGENTS.md", content: "local" },
    ],
    skills: [{ name: "s", description: "d", filePath: "/local/skill/SKILL.md" } as Skill],
    sections: { agents_d: "local agents.d" } as Record<string, string>,
  };
  applyRemotePrompt(options, "/local/project", location, context);
  assert.equal(options.cwd, cwd);
  assert.deepEqual(options.contextFiles.filter((file) => !file.path.startsWith("box:/") || file.path.startsWith(`box:${root}`)).map((file) => file.content),
    ["global", "root rules", "preferred middle rules"]);
  assert.deepEqual(options.skills, []);
  assert.match(options.sections.remote!, new RegExp(`Tools run on the remote host box over SSH, in ${cwd}`));
  assert.match(options.sections.agents_d!, /Loaded from box\./);
  assert.match(options.sections.agents_d!, /<file path="AGENTS.d\/notes.md">\nnote body\n<\/file>/);
  assert.match(options.sections.agents_d!, /AGENTS.d\/sub\/\nAGENTS.d\/sub\/deep.md/);
  assert.doesNotMatch(options.sections.agents_d!, /not loaded/);
});
