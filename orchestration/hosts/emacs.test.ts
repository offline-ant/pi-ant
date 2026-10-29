import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEmacsHost } from "./emacs.ts";
import type { HostTarget } from "../host-types.ts";

function fakeEmacs(handler: (data: Record<string, unknown>) => object): ExtensionAPI {
  return {
    async exec(command: string, args: string[]) {
      assert.equal(command, "emacsclient");
      assert.deepEqual(args.slice(0, 3), ["--socket-name", "/test/socket", "--eval"]);
      const encoded = /pi-orchestration-dispatch "([A-Za-z0-9+/=]+)"/.exec(args[3])?.[1];
      assert.ok(encoded);
      const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
      const reply = handler(data);
      return { code: 0, stdout: JSON.stringify(Buffer.from(JSON.stringify(reply)).toString("base64")), stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI;
}

test("Emacs startup waits for readiness then matching prompt acknowledgement", async () => {
  const operations: string[] = [];
  let stateReads = 0;
  let receiptReads = 0;
  const pi = fakeEmacs((data) => {
    const operation = String(data.operation);
    operations.push(operation);
    switch (operation) {
      case "start": return { target: { host: "emacs", endpoint: "/test/socket", id: data.id, kind: "pi", name: "worker" } };
      case "state": return { state: "running", ready: ++stateReads > 1 };
      case "send": {
        assert.deepEqual(data.input, { kind: "prompt", text: "quotes\"\n你好 (kill-emacs)" });
        return { pending: true };
      }
      case "response": return ++receiptReads > 1 ? { success: true } : { pending: true };
      default: throw new Error(`Unexpected operation: ${operation}`);
    }
  });
  const host = createEmacsHost(pi, "/test/socket");
  const target = await host.start({ kind: "pi", name: "worker", cwd: "/tmp", sessionFile: "/tmp/test.jsonl", args: ["--thinking", "high"], placement: "worker", prompt: "quotes\"\n你好 (kill-emacs)" });
  assert.equal(target.host, "emacs");
  assert.deepEqual(operations, ["start", "state", "state", "send", "response", "response"]);
});

test("Emacs rejected prompt throws instead of treating acknowledgement as completion", async () => {
  const pi = fakeEmacs((data) => data.operation === "send" ? { pending: true } : { error: "Compacting" });
  const host = createEmacsHost(pi, "/test/socket");
  const target: HostTarget = { host: "emacs", endpoint: "/test/socket", id: "owned", kind: "pi", name: "worker" };
  await assert.rejects(host.send(target, { kind: "prompt", text: "human" }), /Compacting/);
});

test("Emacs failed startup closes only its preassigned identity", async () => {
  let startedId: unknown;
  let closedId: unknown;
  const pi = fakeEmacs((data) => {
    if (data.operation === "start") {
      startedId = data.id;
      return { error: "Startup failed" };
    }
    assert.equal(data.operation, "close");
    closedId = data.id;
    return { success: true };
  });
  await assert.rejects(createEmacsHost(pi, "/test/socket").start({ kind: "shell", name: "logs", cwd: "/tmp", argv: ["false"], placement: "worker" }), /Startup failed/);
  assert.ok(startedId);
  assert.equal(startedId, closedId);
});

test("Emacs close polls graceful exit without abandoning owned cleanup on cancellation", async () => {
  const controller = new AbortController();
  let closes = 0;
  const pi = fakeEmacs((data) => {
    assert.equal(data.operation, "close");
    assert.equal(data.id, "owned");
    assert.equal(data.force, false);
    controller.abort();
    return ++closes === 1 ? { pending: true } : { success: true };
  });
  await createEmacsHost(pi, "/test/socket").close({ host: "emacs", endpoint: "/test/socket", id: "owned", name: "worker", kind: "pi" }, controller.signal);
  assert.equal(closes, 2);
});

test("Emacs canceled startup releases its target without abandoning owned work", async () => {
  const controller = new AbortController();
  let closed = false;
  const pi = fakeEmacs((data) => {
    if (data.operation === "start") return { target: { host: "emacs", endpoint: "/test/socket", id: data.id, kind: "pi", name: "worker" } };
    if (data.operation === "state") {
      controller.abort();
      return { state: "running", ready: false };
    }
    assert.equal(data.operation, "close");
    closed = true;
    return { success: true };
  });
  await assert.rejects(createEmacsHost(pi, "/test/socket").start({ kind: "pi", name: "worker", cwd: "/tmp", sessionFile: "/tmp/test.jsonl", args: [], placement: "worker" }, controller.signal), /abort/i);
  assert.equal(closed, true);
});

test("an Emacs daemon that no longer listens took its targets with it; a live one's failures propagate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-emacs-socket-"));
  const socket = path.join(dir, "server");
  const unreachable = { async exec() { return { code: 1, stdout: "", stderr: "emacsclient: can't connect", killed: false }; } } as unknown as ExtensionAPI;
  const target: HostTarget = { host: "emacs", endpoint: socket, id: "owned", kind: "shell", name: "logs" };
  const server = net.createServer((client) => client.destroy());
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await assert.rejects(createEmacsHost(unreachable, socket).state(target), /can't connect/);
    await assert.rejects(createEmacsHost(unreachable, socket).close(target), /can't connect/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  assert.equal(await createEmacsHost(unreachable, socket).state(target), "missing");
  await createEmacsHost(unreachable, socket).close(target);
  // A bare server name is no path to probe, so it never proves the daemon gone.
  await assert.rejects(createEmacsHost(unreachable, "pi").state({ ...target, endpoint: "pi" }), /can't connect/);
  fs.rmSync(dir, { recursive: true, force: true });
});
