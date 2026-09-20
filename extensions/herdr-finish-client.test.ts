import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { HerdrApiError, HerdrFinishClient } from "./herdr-finish-client.ts";

const unixOnly = { skip: process.platform === "win32", timeout: 5_000 };
const pane = {
  pane_id: "w1:p1",
  terminal_id: "term_1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent: "pi",
  agent_status: "blocked",
  agent_session: { value: "/tmp/会話\u2028session.jsonl" },
};
const subscriptions = [{ type: "pane.agent_status_changed", pane_id: pane.pane_id }];
const event = { event: "pane.agent_status_changed", data: { pane_id: pane.pane_id, agent_status: "done" } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Request {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

async function serverFixture(t: TestContext, timeoutMs = 1_000) {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-client-"));
  const endpoint = join(directory, "api.sock");
  const received = deferred<{ request: Request; socket: Socket; closed: Promise<void> }>();
  const sockets = new Set<Socket>();
  let connectionCount = 0;
  const server = createServer((socket) => {
    connectionCount++;
    sockets.add(socket);
    const closed = new Promise<void>((resolve) => {
      socket.on("close", () => { sockets.delete(socket); resolve(); });
    });
    // Tests deliberately disconnect on both ends, including while a frame is incomplete.
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(input.slice(0, newline)) as Request;
      received.resolve({ request, socket, closed });
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.removeListener("error", reject); resolve(); });
  });
  return {
    client: new HerdrFinishClient(endpoint, timeoutMs),
    received: received.promise,
    sockets,
    connectionCount: () => connectionCount,
  };
}

function reply(socket: Socket, id: string, result: unknown): void {
  socket.write(`${JSON.stringify({ id, result })}\n`);
}

test("pane.list parses pane identities and closes its one-shot socket", unixOnly, async (t) => {
  const f = await serverFixture(t);
  const result = f.client.panes(new AbortController().signal);
  const { request, socket, closed } = await f.received;
  assert.equal(request.method, "pane.list");
  assert.deepEqual(request.params, {});
  assert.equal(typeof request.id, "string");
  assert.ok(request.id.length > 0);
  reply(socket, request.id, { type: "pane_list", panes: [pane] });
  assert.deepEqual(await result, [pane]);
  await closed;
  assert.equal(f.sockets.size, 0);
});

test("LF framing tolerates fragmented JSON, split UTF-8 and embedded Unicode line separators", unixOnly, async (t) => {
  const f = await serverFixture(t);
  const result = f.client.panes(new AbortController().signal);
  const { request, socket, closed } = await f.received;
  const frame = Buffer.from(`${JSON.stringify({ id: request.id, result: { panes: [pane] } })}\n`);
  const unicode = frame.indexOf(Buffer.from("会"));
  assert.ok(unicode > 0);
  const cuts = [1, 9, unicode + 1, unicode + 2, frame.length - 1, frame.length];
  let offset = 0;
  let settled = false;
  void result.then(() => { settled = true; });
  for (const end of cuts) {
    socket.write(frame.subarray(offset, end));
    offset = end;
    if (end !== frame.length) {
      await nextTurn();
      assert.equal(settled, false, "a partial JSON line must not settle the request");
    }
  }
  assert.deepEqual(await result, [pane]);
  await closed;
});

test("subscriptions require acknowledgement, then deliver multiple events in one frame batch", unixOnly, async (t) => {
  const f = await serverFixture(t);
  const delivered = deferred<void>();
  const failures: Error[] = [];
  let changes = 0;
  let settled = false;
  const ready = f.client.subscribe(subscriptions, () => {
    if (++changes === 2) delivered.resolve();
  }, (error) => failures.push(error), new AbortController().signal);
  void ready.then(() => { settled = true; });
  const { request, socket, closed } = await f.received;
  assert.equal(request.method, "events.subscribe");
  assert.deepEqual(request.params, { subscriptions });
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(changes, 0);
  socket.write([
    JSON.stringify({ id: request.id, result: { type: "subscription_started" } }),
    JSON.stringify(event),
    JSON.stringify({ ...event, data: { ...event.data, agent_status: "working" } }),
    "",
  ].join("\n"));
  const close = await ready;
  await delivered.promise;
  assert.equal(changes, 2);
  assert.deepEqual(failures, []);
  assert.equal(f.sockets.size, 1);
  close();
  close();
  await closed;
  assert.equal(f.sockets.size, 0);
  assert.deepEqual(failures, [], "intentional close is not a connection failure");
});

test("subscription acknowledgement timeout is cleared for a quiet live stream", unixOnly, async (t) => {
  const f = await serverFixture(t, 100);
  const failures: Error[] = [];
  const ready = f.client.subscribe(subscriptions, () => {}, (error) => failures.push(error), new AbortController().signal);
  const { request, socket, closed } = await f.received;
  reply(socket, request.id, { type: "subscription_started" });
  const close = await ready;
  await delay(150);
  assert.deepEqual(failures, []);
  assert.equal(f.sockets.size, 1);
  close();
  await closed;
});

test("server errors before acknowledgement reject with the API code and clean up", unixOnly, async (t) => {
  const f = await serverFixture(t);
  const failures: Error[] = [];
  const ready = f.client.subscribe(subscriptions, () => {}, (error) => failures.push(error), new AbortController().signal);
  const rejection = assert.rejects(ready, (error: unknown) => {
    assert.ok(error instanceof HerdrApiError);
    assert.equal(error.code, "pane_not_found");
    assert.match(error.message, /pane disappeared/);
    return true;
  });
  const { request, socket, closed } = await f.received;
  socket.write(`${JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: "pane disappeared" } })}\n`);
  await rejection;
  await closed;
  assert.deepEqual(failures, []);
});

test("malformed response envelopes and subscription acknowledgements reject", unixOnly, async (t) => {
  const cases = [
    { name: "invalid JSON", frame: (_id: string) => "{broken\n", match: /JSON|property|position/i },
    { name: "array envelope", frame: (_id: string) => "[]\n", match: /Invalid Herdr response/ },
    { name: "wrong ID", frame: (_id: string) => `${JSON.stringify({ id: "other", result: { type: "subscription_started" } })}\n`, match: /response ID/ },
    { name: "missing result", frame: (id: string) => `${JSON.stringify({ id })}\n`, match: /Invalid Herdr response/ },
    { name: "wrong acknowledgement", frame: (id: string) => `${JSON.stringify({ id, result: { type: "pane_list" } })}\n`, match: /subscription acknowledgement/ },
    { name: "event before acknowledgement", frame: (_id: string) => `${JSON.stringify(event)}\n`, match: /response ID/ },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const f = await serverFixture(subtest);
      const failures: Error[] = [];
      const ready = f.client.subscribe(subscriptions, () => {}, (error) => failures.push(error), new AbortController().signal);
      const rejection = assert.rejects(ready, entry.match);
      const { request, socket, closed } = await f.received;
      socket.write(entry.frame(request.id));
      await rejection;
      await closed;
      assert.deepEqual(failures, []);
    });
  }
});

test("pane.list rejects malformed lists and required pane fields", unixOnly, async (t) => {
  const cases: Array<{ name: string; result: unknown; match: RegExp }> = [
    { name: "missing list", result: {}, match: /pane list/ },
    { name: "non-array list", result: { panes: {} }, match: /pane list/ },
    { name: "null pane", result: { panes: [null] }, match: /Invalid Herdr response/ },
    ...["pane_id", "terminal_id", "workspace_id", "tab_id", "agent_status"].map((key) => ({
      name: `invalid ${key}`, result: { panes: [{ ...pane, [key]: "" }] }, match: new RegExp(`pane ${key}`),
    })),
    { name: "invalid agent", result: { panes: [{ ...pane, agent: 1 }] }, match: /Invalid Herdr agent/ },
    { name: "invalid session", result: { panes: [{ ...pane, agent_session: { value: 1 } }] }, match: /agent session/ },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const f = await serverFixture(subtest);
      const result = f.client.panes(new AbortController().signal);
      const rejection = assert.rejects(result, entry.match);
      const { request, socket, closed } = await f.received;
      reply(socket, request.id, entry.result);
      await rejection;
      await closed;
    });
  }
});

test("malformed events and server errors after acknowledgement fail the stream once", unixOnly, async (t) => {
  const cases = [
    { name: "missing event", frame: "{}\n", match: /Invalid Herdr event/ },
    { name: "non-object data", frame: `${JSON.stringify({ event: "pane.closed", data: [] })}\n`, match: /Invalid Herdr response/ },
    { name: "invalid JSON", frame: "not-json\n", match: /JSON|Unexpected token/i },
    { name: "API error", frame: `${JSON.stringify({ error: { code: "server_unavailable", message: "shutting down" } })}\n`, match: /shutting down/ },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const f = await serverFixture(subtest);
      const failed = deferred<Error>();
      let failureCount = 0;
      let changes = 0;
      const ready = f.client.subscribe(subscriptions, () => { changes++; }, (error) => {
        failureCount++;
        failed.resolve(error);
      }, new AbortController().signal);
      const { request, socket, closed } = await f.received;
      reply(socket, request.id, { type: "subscription_started" });
      const close = await ready;
      socket.write(entry.frame);
      assert.match((await failed.promise).message, entry.match);
      await closed;
      close();
      assert.equal(failureCount, 1);
      assert.equal(changes, 0);
    });
  }
});

test("oversized complete and unterminated frames are rejected and closed", unixOnly, async (t) => {
  for (const newline of [false, true]) {
    await t.test(newline ? "complete line" : "unterminated line", async (subtest) => {
      const f = await serverFixture(subtest);
      const result = f.client.panes(new AbortController().signal);
      const rejection = assert.rejects(result, /response too large/);
      const { socket, closed } = await f.received;
      socket.write(" ".repeat(4 * 1024 * 1024 + 1) + (newline ? "\n" : ""));
      await rejection;
      await closed;
    });
  }
});

test("missing acknowledgement times out and closes the socket", unixOnly, async (t) => {
  const f = await serverFixture(t, 50);
  const failures: Error[] = [];
  const ready = f.client.subscribe(subscriptions, () => {}, (error) => failures.push(error), new AbortController().signal);
  const rejection = assert.rejects(ready, /events.subscribe timed out/);
  const { closed } = await f.received;
  await rejection;
  await closed;
  assert.deepEqual(failures, []);
  assert.equal(f.sockets.size, 0);
});

test("an already-aborted signal opens no connection", unixOnly, async (t) => {
  const f = await serverFixture(t);
  const controller = new AbortController();
  const reason = new Error("cancelled before connection");
  controller.abort(reason);
  await assert.rejects(f.client.panes(controller.signal), (error: unknown) => error === reason);
  await assert.rejects(f.client.subscribe(subscriptions, () => {}, () => {}, controller.signal), (error: unknown) => error === reason);
  await nextTurn();
  assert.equal(f.connectionCount(), 0);
});

test("cancellation before acknowledgement rejects and closes without a stream failure callback", unixOnly, async (t) => {
  const f = await serverFixture(t);
  const controller = new AbortController();
  const reason = new Error("cancel pending acknowledgement");
  const failures: Error[] = [];
  const ready = f.client.subscribe(subscriptions, () => {}, (error) => failures.push(error), controller.signal);
  const rejection = assert.rejects(ready, (error: unknown) => error === reason);
  const { closed } = await f.received;
  controller.abort(reason);
  await rejection;
  await closed;
  assert.deepEqual(failures, []);
});

test("cancellation after acknowledgement reports its reason once and closes", unixOnly, async (t) => {
  const f = await serverFixture(t);
  const controller = new AbortController();
  const reason = new Error("cancel live subscription");
  const failures: Error[] = [];
  const ready = f.client.subscribe(subscriptions, () => {}, (error) => failures.push(error), controller.signal);
  const { request, socket, closed } = await f.received;
  reply(socket, request.id, { type: "subscription_started" });
  const close = await ready;
  controller.abort(reason);
  await closed;
  close();
  assert.deepEqual(failures, [reason]);
  assert.equal(f.sockets.size, 0);
});

test("explicit close removes the abort listener and does not report a later cancellation", unixOnly, async (t) => {
  const f = await serverFixture(t);
  const controller = new AbortController();
  const failures: Error[] = [];
  const ready = f.client.subscribe(subscriptions, () => {}, (error) => failures.push(error), controller.signal);
  const { request, socket, closed } = await f.received;
  reply(socket, request.id, { type: "subscription_started" });
  const close = await ready;
  close();
  await closed;
  controller.abort(new Error("already closed"));
  assert.deepEqual(failures, []);
});

test("unexpected close before acknowledgement rejects the pending request", unixOnly, async (t) => {
  const f = await serverFixture(t);
  const result = f.client.panes(new AbortController().signal);
  const rejection = assert.rejects(result, /connection closed/);
  const { socket, closed } = await f.received;
  socket.end('{"partial":');
  await rejection;
  await closed;
});

test("unexpected close after acknowledgement reports failure exactly once", unixOnly, async (t) => {
  const f = await serverFixture(t);
  const failed = deferred<Error>();
  let failureCount = 0;
  const ready = f.client.subscribe(subscriptions, () => {}, (error) => {
    failureCount++;
    failed.resolve(error);
  }, new AbortController().signal);
  const { request, socket, closed } = await f.received;
  reply(socket, request.id, { type: "subscription_started" });
  const close = await ready;
  socket.end();
  assert.match((await failed.promise).message, /connection closed/);
  await closed;
  close();
  assert.equal(failureCount, 1);
});
