export type HostKind = "tmux" | "herdr" | "emacs";
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
  | { kind: "shell"; command: string }
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
