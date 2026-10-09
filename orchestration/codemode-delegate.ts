import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Global, opt-in callable exposure; no file exists for the default model-only policy. */
export function createCodemodeDelegateController(pi: ExtensionAPI, changed: (enabled: boolean) => void): {
  refresh(ctx: ExtensionContext): boolean;
} {
  const file = path.join(getAgentDir(), "codemode-delegate.json");
  let enabled = false;
  let lastError: string | undefined;

  function refresh(ctx: ExtensionContext): boolean {
    let next = false;
    let error: string | undefined;
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || typeof data !== "object" || !("enabled" in data) || data.enabled !== true) {
        throw new Error("Expected { enabled: true }; remove the file to disable.");
      }
      next = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        error = `Codemode delegation disabled: invalid configuration at ${file}: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
    if (next !== enabled) {
      enabled = next;
      changed(enabled);
    }
    if (error && error !== lastError) ctx.ui.notify(error, "error");
    lastError = error;
    return enabled;
  }

  function report(ctx: ExtensionContext): void {
    const text = lastError ?? (enabled
      ? `Codemode delegation enabled globally: active do, delegate, and fresh_look tools are callable from scripts and other tools. Scripts receive text only; cancellation may omit recovery receipts. Saved in ${file}.`
      : "Codemode delegation disabled globally: do, delegate, and fresh_look are model-only (the default).");
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else pi.sendMessage({ customType: "pi-orchestration:codemode-delegate-status", content: text, display: true });
  }

  pi.registerCommand("codemode-delegate", {
    description: "Toggle codemode delegation, or set on/off/status (saved globally; off by default)",
    getArgumentCompletions(prefix) {
      return ["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      refresh(ctx);
      const choice = args.trim();
      if (choice === "status") { report(ctx); return; }
      if (!["", "on", "off"].includes(choice)) throw new Error("Usage: /codemode-delegate [on|off|status]. Omit arguments to toggle.");
      const next = choice === "" ? !enabled : choice === "on";
      if (next) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, `${JSON.stringify({ enabled: true })}\n`, { mode: 0o600, flag: "wx" });
          fs.renameSync(temporary, file);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      } else fs.rmSync(file, { force: true });
      refresh(ctx);
      report(ctx);
    },
  });
  pi.on("session_start", async (_event, ctx) => { refresh(ctx); });
  pi.on("input", async (_event, ctx) => { refresh(ctx); });
  return { refresh };
}
