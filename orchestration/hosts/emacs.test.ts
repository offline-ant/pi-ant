import assert from "node:assert/strict";
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
  await assert.rejects(createEmacsHost(pi, "/test/socket").start({ kind: "shell", name: "logs", cwd: "/tmp", command: "false", placement: "worker" }), /Startup failed/);
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
