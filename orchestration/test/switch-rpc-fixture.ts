import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSwitch } from "../extensions/switch.ts";

/** Real RPC lifecycle, with only destination transport replaced. No inference. */
export default function switchRpcFixture(pi: ExtensionAPI): void {
  const directory = process.cwd();
  const trace = (entry: object): void => fs.appendFileSync(path.join(directory, "trace.jsonl"), `${JSON.stringify(entry)}\n`);
  const provider = fauxProvider({ provider: "switch-rpc-fixture", models: [{ id: "one" }] });
  provider.setResponses([() => { trace({ event: "unexpected-inference" }); throw new Error("Switch must not call a model"); }]);
  pi.registerProvider(provider.provider);
  pi.on("session_start", (_event, ctx) => {
    trace({ event: "start", file: ctx.sessionManager.getSessionFile(), mode: ctx.mode });
  });
  pi.on("session_shutdown", async (event, ctx) => {
    trace({ event: "shutdown-start", file: ctx.sessionManager.getSessionFile(), reason: event.reason });
    await delay(50);
    trace({ event: "shutdown-complete", file: ctx.sessionManager.getSessionFile(), reason: event.reason });
  });
  registerSwitch(pi, {
    environment: () => ({ ...process.env, PI_ORCHESTRATION_HOST: "web" }),
    targets: () => [],
    prepare: async (_kind, source) => ({
      start: async () => {
        trace({ event: "destination-start", file: source.sessionFile });
        // Let the test inspect the refreshed source before destination readiness.
        // The test releases this gate without writing further RPC input.
        while (!fs.existsSync(path.join(directory, "release"))) await delay(20);
        trace({ event: "destination-ready", file: source.sessionFile });
        return "fixture Herdr destination";
      },
    }),
  });
}
