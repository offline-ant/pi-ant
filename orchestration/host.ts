import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Host, HostKind, HostTarget } from "./host-types.ts";
import { createEmacsHost } from "./hosts/emacs.ts";
import { createHerdrHost } from "./hosts/herdr.ts";
import { createTmuxHost } from "./hosts/tmux.ts";
import { childNestingEnvironment } from "./nesting.ts";

interface HostState {
  selection?: { kind: HostKind; endpoint: string };
  startup: Promise<void>;
}
const STATE = Symbol.for("pi-ant.orchestration.host");
function state(): HostState {
  const globals = globalThis as typeof globalThis & { [STATE]?: HostState };
  return globals[STATE] ??= { startup: Promise.resolve() };
}

export function selectHost(env: NodeJS.ProcessEnv): { kind: HostKind; endpoint: string } {
  const explicit = env.PI_ORCHESTRATION_HOST;
  const herdr = env.HERDR_ENV === "1" && Boolean(env.HERDR_SOCKET_PATH);
  const tmux = Boolean(env.TMUX);
  if (!explicit && herdr && tmux) throw new Error("Both Herdr and tmux are present; set PI_ORCHESTRATION_HOST explicitly");
  const kind = explicit ?? (herdr ? "herdr" : tmux ? "tmux" : undefined);
  if (kind !== "herdr" && kind !== "tmux" && kind !== "emacs") {
    throw new Error("Orchestration needs tmux, Herdr, or Pilish; set PI_ORCHESTRATION_HOST to select one");
  }
  const endpoint = env.PI_ORCHESTRATION_ENDPOINT ?? (kind === "herdr" ? env.HERDR_SOCKET_PATH : kind === "tmux" ? env.TMUX?.split(",")[0] : undefined);
  if (!endpoint) throw new Error(`No ${kind} endpoint; set PI_ORCHESTRATION_ENDPOINT`);
  return { kind, endpoint };
}

function createHost(pi: ExtensionAPI, kind: HostKind, endpoint: string): Host {
  const native = kind === "herdr" ? createHerdrHost(pi, endpoint) : kind === "tmux" ? createTmuxHost(pi, endpoint) : createEmacsHost(pi, endpoint);
  return {
    ...native,
    start(spec, signal) {
      const start = () => {
        signal?.throwIfAborted();
        const nesting = spec.kind === "pi" ? childNestingEnvironment()
          : process.env.PI_NESTED === undefined ? {} : { PI_NESTED: process.env.PI_NESTED };
        return native.start({
          ...spec,
          env: {
            ...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}),
            ...spec.env, ...nesting, PI_ORCHESTRATION_HOST: kind, PI_ORCHESTRATION_ENDPOINT: endpoint,
          },
        }, signal);
      };
      if (spec.kind !== "pi") return start();
      // Shared across extension instances. Only authentication-sensitive startup is serialized.
      const shared = state();
      const operation = shared.startup.then(start);
      shared.startup = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}

/** Called by an orchestration operation, not by extension discovery/startup. */
export function getHost(pi: ExtensionAPI): Host {
  const shared = state();
  const selected = shared.selection ??= selectHost(process.env);
  return createHost(pi, selected.kind, selected.endpoint);
}

/** Never resolve a stored target against today's environment. */
export function hostForTarget(pi: ExtensionAPI, target: HostTarget): Host {
  return createHost(pi, target.host, target.endpoint);
}
