import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getHost, getHostState, setHostOverride } from "../host.ts";
import orchestrationHostExtension, { ORCHESTRATION_HOST_ENTRY } from "./orchestration-host.ts";

const keys = ["PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "HERDR_ENV", "HERDR_SOCKET_PATH", "TMUX"];
const previous = keys.map((key) => process.env[key]);
before(() => {
  process.env.PI_ORCHESTRATION_HOST = "emacs";
  process.env.PI_ORCHESTRATION_ENDPOINT = "/tmp/emacs-server";
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
  delete process.env.TMUX;
});
after(() => {
  setHostOverride(null);
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  });
});

function fixture() {
  type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let handler: Handler | undefined;
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<void>>();
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  let pick: ((labels: string[]) => string | undefined) | undefined;
  const pi = {
    registerCommand: (_name: string, spec: { handler: Handler }) => { handler = spec.handler; },
    on: (name: string, listener: (event: unknown, ctx: ExtensionCommandContext) => Promise<void>) => events.set(name, listener),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      select: async (_title: string, labels: string[]) => pick?.(labels),
    },
  } as unknown as ExtensionCommandContext;
  orchestrationHostExtension(pi);
  return {
    pi, ctx, entries, notifications, statuses, events,
    run: (args: string) => handler!(args, ctx),
    choose: (chooser: (labels: string[]) => string | undefined) => { pick = chooser; },
  };
}

test("arguments select, report, and reset a branch override used by new host operations", async () => {
  const f = fixture();
  await f.run("status");
  assert.match(f.notifications.at(-1)!, /Orchestration host: emacs \(environment, \/tmp\/emacs-server\).*Reachable: herdr, emacs/);
  assert.equal(f.entries.length, 0);

  await f.run("herdr");
  assert.deepEqual(f.entries.at(-1), { type: "custom", customType: ORCHESTRATION_HOST_ENTRY, data: { host: "herdr" } });
  assert.equal(getHost(f.pi).kind, "herdr");
  assert.equal(getHost(f.pi).endpoint, "/tmp/herdr.sock");
  assert.equal(f.statuses.at(-1), "host:herdr*");
  await f.run("herdr");
  assert.equal(f.entries.length, 1, "an unchanged selection appends nothing");

  await assert.rejects(f.run("tmux"), /'tmux' is not reachable.*reachable: herdr, emacs/);
  await assert.rejects(f.run("screen"), /Usage/);
  assert.equal(getHostState().override, "herdr");

  await f.run("reset");
  assert.deepEqual(f.entries.at(-1)?.data, { host: null });
  assert.equal(getHost(f.pi).kind, "emacs");
  assert.equal(f.statuses.at(-1), "host:emacs");
});

test("the picker offers reachable hosts only; session events restore the branch selection", async () => {
  const f = fixture();
  let offered: string[] = [];
  f.choose((labels) => { offered = labels; return labels.find((label) => label.startsWith("herdr")); });
  await f.run("");
  assert.deepEqual(offered, ["Use environment default (emacs)", "herdr (/tmp/herdr.sock)", "emacs (/tmp/emacs-server)"]);
  assert.equal(getHostState().override, "herdr");

  f.choose(() => undefined);
  await f.run("");
  assert.equal(getHostState().override, "herdr", "cancelling keeps the selection");

  setHostOverride(null);
  await f.events.get("session_start")!({}, f.ctx);
  assert.equal(getHostState().override, "herdr");
  f.entries.length = 0;
  await f.events.get("session_tree")!({}, f.ctx);
  assert.equal(getHostState().override, null);
});
