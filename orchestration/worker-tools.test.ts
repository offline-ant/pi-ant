import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkerToolResolver } from "./worker-tools.ts";

test("worker tools follow the caller or the delegated profile and include delegate", () => {
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
  assert.deepEqual(resolver.current(), ["read", "coding-agent", "delegate"]);
  eventHandler?.({ delegatedTools: ["read", "web_search", "delegate"] });
  assert.deepEqual(resolver.current(), ["read", "web_search", "delegate"]);
  resolver.dispose();
  assert.equal(disposed, true);
});
