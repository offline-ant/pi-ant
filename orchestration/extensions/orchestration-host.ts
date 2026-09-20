import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getHostState, setHostOverride, type OrchestrationHostState } from "../host.ts";
import { HOST_KINDS, isHostKind, type HostKind } from "../host-types.ts";

export const ORCHESTRATION_HOST_ENTRY = "pi-orchestration:host";
const USAGE = `Usage: /orchestration-host [${HOST_KINDS.join("|")}|reset|status]`;

/** Follow the current branch, not entries from abandoned branches. */
function savedOverride(ctx: ExtensionContext): HostKind | null {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== ORCHESTRATION_HOST_ENTRY) continue;
    const data: unknown = entry.data;
    if (!data || typeof data !== "object" || !("host" in data)) continue;
    if (data.host === null || isHostKind(data.host)) return data.host;
  }
  return null;
}

function description(state: OrchestrationHostState): string {
  const current = state.effective
    ? `${state.effective.kind} (${state.override === null ? "environment" : "session override"}, ${state.effective.endpoint})`
    : `unavailable - ${state.unavailable}`;
  const reachable = state.available.map((host) => host.kind).join(", ") || "none";
  return `Orchestration host: ${current}. Environment default: ${state.configured?.kind ?? "none"}. Reachable: ${reachable}. Changes apply to new workers, panels, and forks; existing ones keep their host.`;
}

export default function orchestrationHostExtension(pi: ExtensionAPI): void {
  function refresh(ctx: ExtensionContext): OrchestrationHostState {
    setHostOverride(savedOverride(ctx));
    const state = getHostState();
    ctx.ui.setStatus("orchestration-host", state.available.length > 1 || state.override !== null
      ? `host:${state.effective?.kind ?? "unavailable"}${state.override === null ? "" : "*"}` : undefined);
    return state;
  }

  function report(ctx: ExtensionContext, text: string): void {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else pi.sendMessage({ customType: "pi-orchestration:host-status", content: text, display: true });
  }

  pi.registerCommand("orchestration-host", {
    description: `Choose the host for new workers, panels, and forks: ${HOST_KINDS.join(", ")}, reset, or status (session override)`,
    getArgumentCompletions(prefix) {
      return [...HOST_KINDS, "reset", "status"].filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      let selected = args.trim();
      if (selected && selected !== "reset" && selected !== "status" && !isHostKind(selected)) throw new Error(USAGE);
      const current = refresh(ctx);
      if (selected === "status" || (!selected && !ctx.hasUI)) { report(ctx, description(current)); return; }
      if (!selected) {
        const choices = [
          { value: "reset", label: `Use environment default (${current.configured?.kind ?? "none"})` },
          ...current.available.map((host) => ({ value: host.kind as string, label: `${host.kind} (${host.endpoint})` })),
        ];
        const choice = await ctx.ui.select(description(current), choices.map((item) => item.label), { signal: ctx.signal });
        const match = choices.find((item) => item.label === choice);
        if (!match) return;
        selected = match.value;
      }
      const host = selected === "reset" ? null : selected;
      if (host !== null && !isHostKind(host)) throw new Error(USAGE);
      if (host !== null && !current.available.some((item) => item.kind === host)) {
        const reachable = current.available.map((item) => item.kind).join(", ") || "none";
        throw new Error(`Orchestration host '${host}' is not reachable from this Pi process (reachable: ${reachable}).`);
      }
      // An explicit null entry clears older branch overrides.
      if (savedOverride(ctx) !== host) pi.appendEntry(ORCHESTRATION_HOST_ENTRY, { host });
      report(ctx, description(refresh(ctx)));
    },
  });
  pi.on("session_start", async (_event, ctx) => { refresh(ctx); });
  pi.on("session_tree", async (_event, ctx) => { refresh(ctx); });
  pi.on("input", async (_event, ctx) => { refresh(ctx); });
}
