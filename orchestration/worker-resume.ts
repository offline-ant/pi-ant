import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Reopen the saved transcript, not the private /worker-run request. Pi restores its cwd. */
export function workerResumeCommand(sessionFile: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
  // A resume launched from another Pi's shell must not inherit its worker identity
  // or bind its private input socket. Do not copy host endpoints or credentials.
  const args = ["env", "-u", "PI_NESTED", "-u", "PI_ORCHESTRATION_CONTROL", "-u", "PI_ORCHESTRATION_TARGET"];
  if (process.env.PI_CODING_AGENT_DIR) args.push(quote(`PI_CODING_AGENT_DIR=${resolve(getAgentDir())}`));
  args.push("pi", "--session", quote(sessionFile));
  return args.join(" ");
}

export function workerResumeHint(command: string): string {
  return `To resume/continue after the worker stops, run:\n${command}\nOpens an ordinary session; enter a prompt to continue.`;
}
