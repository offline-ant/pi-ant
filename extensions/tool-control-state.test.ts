import assert from "node:assert/strict";
import test from "node:test";
import {
  activeToolsForState,
  createProfileState,
  eventForState,
  parseToolControlState,
  profileIsModified,
  toolControlStatesEqual,
} from "./tool-control-state.ts";

test("profile state is exact and detects manual changes", () => {
  const state = createProfileState("research", "now");
  assert.equal(profileIsModified(state), false);
  state.enabledTools = state.enabledTools.filter((tool) => tool !== "browser");
  assert.equal(profileIsModified(state), true);
});

test("saved-default equality ignores order and timestamps but preserves profile identity", () => {
  const left = { ...createProfileState("research", "earlier"), enabledTools: ["read", "bash"] };
  const right = { ...createProfileState("research", "later"), enabledTools: ["bash", "read"] };
  assert.equal(toolControlStatesEqual(left, right), true);
  assert.equal(toolControlStatesEqual(left, { ...right, profile: "coding" }), false);
});

test("active tools filter unavailable entries and add required tools", () => {
  const state = createProfileState("coding", "now");
  assert.deepEqual(
    activeToolsForState(state, ["read", "bash", "sqlite"], ["sqlite"]),
    ["read", "bash", "sqlite"],
  );
});

test("Bob's profile has deterministic delegated research tools", () => {
  const state = createProfileState("bobs", "now");
  const event = eventForState(state, ["delegate", "coding-agent", "ask", "fresh-history", "read", "bash", "web_search"]);
  assert.deepEqual(event.enabledTools, ["delegate", "coding-agent", "ask", "fresh-history"]);
  assert.deepEqual(event.delegatedTools, ["read", "bash", "ask", "delegate", "web_search"]);
});

test("stored state parsing rejects malformed values and removes duplicates", () => {
  assert.equal(parseToolControlState({ profile: "missing", enabledTools: [], updatedAt: "now" }), undefined);
  assert.deepEqual(
    parseToolControlState({ profile: "coding", enabledTools: ["read", "read"], updatedAt: "now" }),
    { profile: "coding", enabledTools: ["read"], updatedAt: "now" },
  );
});
