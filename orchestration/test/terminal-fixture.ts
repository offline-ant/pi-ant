import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** No provider request can escape this native terminal fixture. */
export default function terminalFixture(pi: ExtensionAPI): void {
  pi.on("input", () => ({ action: "handled" }));
  pi.registerCommand("native-report", {
    handler: async (_args, ctx) => {
      const report = process.env.PI_NATIVE_REPORT;
      if (!report) throw new Error("Missing native smoke report path");
      fs.writeFileSync(report, JSON.stringify({ draft: ctx.ui.getEditorText(), session: ctx.sessionManager.getSessionFile() }));
    },
  });
  pi.registerCommand("native-exit", { handler: async (_args, ctx) => { ctx.shutdown(); } });
}
