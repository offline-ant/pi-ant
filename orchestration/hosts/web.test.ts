import assert from "node:assert/strict";
import * as http from "node:http";
import test, { after } from "node:test";
import type { HostTarget, StartSpec } from "../host-types.ts";
import { createWebHost, parseWebEndpoint, renderEntries } from "./web.ts";

interface FakeSession {
  id: string;
  body: Record<string, unknown>;
  prompts: string[];
  entries: unknown[];
}

interface FakeServer {
  endpoint: string;
  sessions: Map<string, FakeSession>;
  authorizations: string[];
  close(): Promise<void>;
}

/** The subset of tau's HTTP API the web host uses. */
async function startFakeTau(options: { credentials?: string; rejectPrompts?: boolean } = {}): Promise<FakeServer> {
  const sessions = new Map<string, FakeSession>();
  const authorizations: string[] = [];
  let counter = 0;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      authorizations.push(request.headers.authorization ?? "");
      if (options.credentials) {
        const expected = `Basic ${Buffer.from(options.credentials).toString("base64")}`;
        if (request.headers.authorization !== expected) return send(401, { error: "Unauthorized" });
      }
      const body: Record<string, unknown> = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const url = new URL(request.url ?? "/", "http://fake");
      const match = /^\/api\/live-sessions\/([^/]+)(\/snapshot)?$/.exec(url.pathname);
      if (url.pathname === "/api/live-sessions" && request.method === "POST") {
        const id = `tau_${++counter}`;
        sessions.set(id, { id, body, prompts: [], entries: [] });
        return send(200, { session: { id, cwd: body.cwd, sessionFile: body.sessionFile ?? null } });
      }
      if (url.pathname === "/api/rpc" && request.method === "POST") {
        const session = sessions.get(String(body.sessionId));
        if (!session) return send(200, { type: "response", success: false, error: "Live session not found" });
        if (body.type !== "prompt") return send(200, { type: "response", success: false, error: `Unknown command: ${String(body.type)}` });
        if (options.rejectPrompts) return send(200, { type: "response", command: "prompt", success: false, error: "No model selected" });
        assert.equal(body.streamingBehavior, "steer");
        session.prompts.push(String(body.message));
        session.entries.push({ type: "message", message: { role: "user", content: String(body.message) } });
        return send(200, { type: "response", command: "prompt", success: true });
      }
      if (match && match[2] && request.method === "GET") {
        const session = sessions.get(decodeURIComponent(match[1]));
        if (!session) return send(404, { error: "Live session not found" });
        return send(200, { session: { id: session.id }, entries: session.entries });
      }
      if (match && !match[2] && request.method === "DELETE") {
        return send(sessions.delete(decodeURIComponent(match[1])) ? 200 : 404, { success: true });
      }
      send(404, { error: "Not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Fake tau server has no port");
  const credentials = options.credentials ? `${options.credentials}@` : "";
  return {
    endpoint: `http://${credentials}127.0.0.1:${address.port}`,
    sessions, authorizations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const servers: FakeServer[] = [];
after(async () => { for (const server of servers) await server.close(); });
async function fakeTau(options: { credentials?: string; rejectPrompts?: boolean } = {}): Promise<FakeServer> {
  const server = await startFakeTau(options);
  servers.push(server);
  return server;
}

const workerSpec = (overrides: Partial<StartSpec> = {}): StartSpec => ({
  kind: "pi", name: "delegate-1", cwd: process.cwd(), sessionFile: "/tmp/session.jsonl",
  args: ["--provider", "openai", "--model", "gpt-6"], env: { PI_NESTED: "1" },
  placement: "worker", prompt: "/worker-run /tmp/request.json", ...overrides,
} as StartSpec);

test("endpoint credentials become an Authorization header and never a request URL", async () => {
  assert.deepEqual(parseWebEndpoint("http://rs:l@127.0.0.1:3001"), {
    base: "http://127.0.0.1:3001",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from("rs:l").toString("base64")}` },
  });
  assert.deepEqual(parseWebEndpoint("http://127.0.0.1:3001/"), {
    base: "http://127.0.0.1:3001", headers: { "Content-Type": "application/json" },
  });
  assert.throws(() => parseWebEndpoint("/tmp/socket"), /must be a URL/);
  assert.throws(() => parseWebEndpoint("ws://127.0.0.1:3001"), /must use http or https/);

  const server = await fakeTau({ credentials: "rs:l" });
  const host = createWebHost(server.endpoint);
  const target = await host.start(workerSpec());
  assert.ok(server.authorizations.every((value) => value.startsWith("Basic ")));
  await host.close(target);

  const unauthenticated = createWebHost(server.endpoint.replace("rs:l@", ""));
  await assert.rejects(() => unauthenticated.start(workerSpec()), /check the endpoint credentials/);
});

test("a Pi worker starts with its own session file, arguments, and environment, then takes its prompt over RPC", async () => {
  const server = await fakeTau();
  const host = createWebHost(server.endpoint);
  assert.equal(host.parent(), undefined);

  const target = await host.start(workerSpec());
  assert.deepEqual(target, {
    host: "web", endpoint: server.endpoint, id: "tau_1", name: "delegate-1", kind: "pi", sessionFile: "/tmp/session.jsonl",
  });
  const session = server.sessions.get("tau_1");
  assert.ok(session);
  assert.equal(session.body.cwd, process.cwd());
  assert.equal(session.body.sessionFile, "/tmp/session.jsonl");
  assert.deepEqual(session.body.args, ["--provider", "openai", "--model", "gpt-6"]);
  assert.deepEqual(session.body.env, { PI_NESTED: "1" });
  // The model comes from the arguments, so the server adds no model of its own.
  assert.equal(session.body.model, undefined);
  assert.deepEqual(session.prompts, ["/worker-run /tmp/request.json"]);

  assert.equal(await host.state(target), "running");
  await host.send(target, { kind: "prompt", text: "continue" });
  assert.deepEqual(session.prompts, ["/worker-run /tmp/request.json", "continue"]);
  assert.match(await host.read(target, 80), /user: \/worker-run \/tmp\/request\.json\n\nuser: continue/);

  await host.close(target);
  assert.equal(server.sessions.has("tau_1"), false);
  assert.equal(await host.state(target), "missing");
  await assert.rejects(() => host.read(target, 10), /no longer exists/);
  await assert.rejects(() => host.send(target, { kind: "prompt", text: "late" }), /Live session not found/);
  // Closing an already closed session is not an error: the surface is gone either way.
  await host.close(target);
});

test("the web host refuses work that needs a terminal, and reports unreachable servers", async () => {
  const server = await fakeTau();
  const host = createWebHost(server.endpoint);
  await assert.rejects(
    () => host.start({ kind: "shell", name: "build", cwd: process.cwd(), command: "npm run build", placement: "worker" }),
    /no terminal for shell panels/,
  );
  const target = await host.start(workerSpec({ prompt: undefined }));
  await assert.rejects(() => host.send(target, { kind: "text", text: "hello", enter: true }), /no terminal/);
  await assert.rejects(() => host.send(target, { kind: "keys", keys: ["ctrl+c"] }), /no terminal/);
  assert.deepEqual(server.sessions.get("tau_1")?.prompts, []);

  const stopped = await startFakeTau();
  await stopped.close();
  await assert.rejects(() => createWebHost(stopped.endpoint).start(workerSpec()), /Could not reach the web host/);
});

test("a start whose prompt is refused closes the session it created instead of leaking it", async () => {
  const server = await fakeTau({ rejectPrompts: true });
  const host = createWebHost(server.endpoint);
  await assert.rejects(() => host.start(workerSpec()), /rejected the prompt for delegate-1: No model selected/);
  assert.equal(server.sessions.size, 0);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(() => host.start(workerSpec(), cancelled.signal), { name: "AbortError" });
  assert.equal(server.sessions.size, 0);
});

test("reads render the transcript tail, not raw entry objects", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "run the build" } },
    { type: "custom", data: { ignored: true } },
    { type: "message", message: { role: "assistant", content: [
      { type: "thinking", text: "hidden" },
      { type: "text", text: "starting" },
      { type: "toolCall", name: "bash", id: "1" },
      { type: "image" },
    ] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "   " }] } },
  ];
  assert.equal(renderEntries(entries, 80), "user: run the build\n\nassistant: starting\n[tool bash]\n[image]");
  assert.equal(renderEntries(entries, 2), "[tool bash]\n[image]");
  assert.equal(renderEntries([], 5), "");
});

test("a target keeps its own server, so later operations never follow a different endpoint", async () => {
  const first = await fakeTau();
  const second = await fakeTau();
  const target: HostTarget = { host: "web", endpoint: first.endpoint, id: "tau_1", name: "worker", kind: "pi" };
  await createWebHost(first.endpoint).start(workerSpec({ prompt: undefined }));
  assert.equal(await createWebHost(target.endpoint).state(target), "running");
  assert.equal(await createWebHost(second.endpoint).state({ ...target, endpoint: second.endpoint }), "missing");
});
