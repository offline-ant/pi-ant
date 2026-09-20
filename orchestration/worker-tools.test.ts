import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkerToolResolver } from "./worker-tools.ts";

test("worker tools follow the caller or delegated profile and always include do, not optional tools", () => {
  let eventHandler: ((value: unknown) => void) | undefined;
  let disposed = false;
  const pi = {
    events: {
      on: (_name: string, handler: (value: unknown) => void) => {
        eventHandler = handler;
        return () => {
          disposed = true;
        };
      },
    },
    getActiveTools: () => ["read", "coding-agent"],
  } as unknown as ExtensionAPI;

  const resolver = createWorkerToolResolver(pi);
  assert.deepEqual(resolver.current(), ["read", "coding-agent", "do"]);
  eventHandler?.({ delegatedTools: ["read", "web_search", "delegate", "do"] });
  assert.deepEqual(resolver.current(), ["read", "web_search", "delegate", "do"]);
  eventHandler?.({ delegatedTools: ["read", "fresh_look"] });
  assert.deepEqual(resolver.current(), ["read", "fresh_look", "do"], "explicit fresh_look selection must propagate");
  eventHandler?.({});
  assert.deepEqual(resolver.current(), ["read", "coding-agent", "do"], "leaving a profile restores caller tools");
  resolver.dispose();
  assert.equal(disposed, true);
});
