import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";

/**
 * A fake `ssh` first on PATH: it skips options, logs the destination and remote
 * command, and runs the command with sh in a private "remote home" on this
 * machine. Destinations starting with `down` fail like an unreachable host.
 */
export function installSshStub(t: TestContext): { home: string; root: string; scripts(): Array<{ destination: string; script: string }> } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-ssh-stub-")));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const log = path.join(root, "ssh.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(bin, "ssh"), [
    "#!/bin/sh",
    "dest=",
    "while [ $# -gt 0 ]; do",
    '  case "$1" in -o) shift 2 ;; -t|-T) shift ;; *) dest=$1; shift; break ;; esac',
    "done",
    `printf '%s\\t%s\\n' "$dest" "$1" >> ${JSON.stringify(log)}`,
    'case "$dest" in down*) echo "ssh: connect to host $dest port 22: Connection refused" >&2; exit 255 ;; esac',
    `cd ${JSON.stringify(home)} || exit 255`,
    `HOME=${JSON.stringify(home)} exec sh -c "$1"`,
  ].join("\n"), { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    home,
    root,
    scripts: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => {
      const [destination, command] = line.split("\t");
      const encoded = /printf %s (\S+) \|/.exec(command ?? "")?.[1] ?? "";
      return { destination: destination!, script: Buffer.from(encoded, "base64").toString() };
    }),
  };
}

const REMOTE_STATE = Symbol.for("pi-ant.orchestration.remote");

/** Each test represents a new Pi process; the remote target is process-pinned. */
export function setSessionRemote(t: TestContext, spec: string | undefined): void {
  const globals = globalThis as typeof globalThis & { [REMOTE_STATE]?: unknown };
  const previousState = globals[REMOTE_STATE];
  const previousEnv = process.env.PI_REMOTE;
  delete globals[REMOTE_STATE];
  if (spec === undefined) delete process.env.PI_REMOTE;
  else process.env.PI_REMOTE = spec;
  t.after(() => {
    if (previousState === undefined) delete globals[REMOTE_STATE];
    else globals[REMOTE_STATE] = previousState;
    if (previousEnv === undefined) delete process.env.PI_REMOTE;
    else process.env.PI_REMOTE = previousEnv;
  });
}
