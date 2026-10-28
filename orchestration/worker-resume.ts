import { basename, dirname, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { REMOTE_ENV } from "./remote-session.ts";

/**
 * Reopen the saved transcript, not the private /worker-run request. Pi restores its cwd;
 * a remote worker's SSH target is restored explicitly, and never inherited otherwise.
 */
export function workerResumeCommand(sessionFile: string, remote?: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
  // A resume launched from another Pi's shell must not inherit its worker identity
  // or bind its private input socket. Do not copy host endpoints or credentials.
  const args = ["env", "-u", "PI_NESTED", "-u", "PI_ORCHESTRATION_CONTROL", "-u", "PI_ORCHESTRATION_TARGET"];
  args.push(...remote === undefined ? ["-u", REMOTE_ENV] : [quote(`${REMOTE_ENV}=${remote}`)]);
  if (process.env.PI_CODING_AGENT_DIR) args.push(quote(`PI_CODING_AGENT_DIR=${resolve(getAgentDir())}`));
  args.push("pi", "--session", quote(sessionFile));
  return args.join(" ");
}

/** Pilish's `details.savedConversations` declaration: a read-only link to the worker's transcript. */
export interface SavedConversations {
  version: 1;
  root: string;
  items: { sessionId: string; file: string; label: string }[];
}

export function workerSavedConversations(sessionFile: string, sessionId: string, label: string): SavedConversations {
  const file = resolve(sessionFile);
  return { version: 1, root: dirname(file), items: [{ sessionId, file: basename(file), label }] };
}

export function workerResumeHint(command: string): string {
  return `To resume/continue after the worker stops, run:\n${command}\nOpens an ordinary session; enter a prompt to continue.`;
}
