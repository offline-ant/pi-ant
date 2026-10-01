export const HOST_KINDS = ["tmux", "herdr", "emacs", "web"] as const;
export type HostKind = (typeof HOST_KINDS)[number];
export function isHostKind(value: unknown): value is HostKind {
  return typeof value === "string" && (HOST_KINDS as readonly string[]).includes(value);
}
/** One reachable host and the endpoint its operations need. */
export interface HostSelection {
  kind: HostKind;
  endpoint: string;
}
export interface HostTarget {
  host: HostKind;
  endpoint: string;
  id: string;
  kind: "pi" | "shell";
  name: string;
  paneId?: string;
  sessionFile?: string;
  controlPath?: string;
}
interface StartBase {
  name: string;
  cwd: string;
  env?: Record<string, string>;
  placement: "worker" | "interactive-fork";
  parent?: HostTarget;
}
export type StartSpec = StartBase & (
  | { kind: "pi"; sessionFile: string; args: string[]; prompt?: string }
  /** Complete command argv, executed verbatim. */
  | { kind: "shell"; argv: string[] }
);
export type HostInput =
  | { kind: "prompt"; text: string }
  | { kind: "text"; text: string; enter: boolean }
  | { kind: "keys"; keys: string[] };
export interface Host {
  readonly kind: HostKind;
  readonly endpoint: string;
  parent(): HostTarget | undefined;
  start(spec: StartSpec, signal?: AbortSignal): Promise<HostTarget>;
  send(target: HostTarget, input: HostInput, signal?: AbortSignal): Promise<void>;
  read(target: HostTarget, lines?: number, signal?: AbortSignal): Promise<string>;
  state(target: HostTarget, signal?: AbortSignal): Promise<"running" | "exited" | "missing">;
  close(target: HostTarget, signal?: AbortSignal): Promise<void>;
}
