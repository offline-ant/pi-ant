import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readVoiceSetting, registerRecSetting } from "./rec-setting.ts";

function fixture(t: TestContext, picked?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rec-setting-test-"));
  const agentDir = path.join(root, "agent");
  const file = path.join(agentDir, "voice.json");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const notifications: Array<{ text: string; level: string }> = [];
  const messages: unknown[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: (text: string, level: string) => notifications.push({ text, level }),
      select: async () => picked,
    },
  } as unknown as ExtensionCommandContext;
  let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
  const pi = {
    registerCommand: (name: string, spec: typeof command) => { assert.equal(name, "rec-setting"); command = spec; },
    sendMessage: (message: unknown) => messages.push(message),
  } as unknown as ExtensionAPI;
  registerRecSetting(pi);
  assert.ok(command);
  return { agentDir, file, ctx, notifications, messages, run: (args: string) => command!.handler(args, ctx) };
}

async function healthServer(t: TestContext): Promise<string> {
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("missing file defaults to claude; set/status write private atomic global config and probe local URL", async (t) => {
  const f = fixture(t);
  assert.deepEqual(readVoiceSetting(f.file), { backend: "claude" });
  await f.run("status");
  assert.match(f.notifications.at(-1)!.text, /claude.*absent: default/);
  assert.equal(fs.existsSync(f.agentDir), false, "status creates nothing");

  const url = await healthServer(t);
  await f.run(`local ${url}/`);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { backend: "local", localUrl: url });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.agentDir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(f.agentDir), ["voice.json"]);
  assert.match(f.notifications.at(-1)!.text, new RegExp(`Saved\\. .*local ${url} — answering\\.`));

  await f.run("claude");
  assert.deepEqual(readVoiceSetting(f.file), { backend: "claude", localUrl: url }, "explicit URL is retained");
  await f.run("local");
  assert.deepEqual(readVoiceSetting(f.file), { backend: "local", localUrl: url });

  await f.run("local http://127.0.0.1:9");
  assert.match(f.notifications.at(-1)!.text, /local http:\/\/127\.0\.0\.1:9 — not answering/);
  f.ctx.hasUI = false;
  await f.run("status");
  assert.match(JSON.stringify(f.messages), /rec-setting-status/);
});

test("default local URL, picker, usage errors, and malformed config are reported", async (t) => {
  const f = fixture(t, "local");
  await f.run("");
  assert.deepEqual(readVoiceSetting(f.file), { backend: "local" });
  assert.match(f.notifications.at(-1)!.text, /local http:\/\/127\.0\.0\.1:8090/);

  await assert.rejects(f.run("openai"), /Usage/);
  await assert.rejects(f.run("claude http://x"), /Usage/);
  await assert.rejects(f.run("local ftp://x"), /credential-free http/);
  await assert.rejects(f.run("local http://u:p@127.0.0.1:1"), /credential-free http/);

  fs.writeFileSync(f.file, `{"backend":"openai"}`);
  assert.throws(() => readVoiceSetting(f.file), /Invalid/);
  await f.run("status");
  assert.deepEqual(f.notifications.at(-1), { text: f.notifications.at(-1)!.text, level: "error" });
  assert.match(f.notifications.at(-1)!.text, /Invalid .*voice\.json/);
  await f.run("claude");
  assert.deepEqual(readVoiceSetting(f.file), { backend: "claude" }, "setting repairs a malformed file");
});
