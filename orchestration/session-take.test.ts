import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { listenTake, requestTake, takeSocket } from "./session-take.ts";

test("a crashed takeover listener can restart without unlinking a live replacement", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-take-crash-"));
  const socket = takeSocket(directory);
  fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  // Kill a separate process: closing a net.Server normally removes its pathname
  // and would not exercise the stale deterministic-address failure.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import net from 'node:net';
    net.createServer().listen(process.env.TAKE_TEST_SOCKET, () => process.stdout.write('ready'));
  `], { env: { ...process.env, TAKE_TEST_SOCKET: socket }, stdio: ["ignore", "pipe", "inherit"] });
  let server: Awaited<ReturnType<typeof listenTake>> | undefined;
  try {
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.ok(fs.lstatSync(socket).isSocket(), "the crash left the socket pathname behind");
    server = await listenTake(socket, (_request, reply) => { void reply({ generation: 2 }); });
    assert.deepEqual(await requestTake(socket, { kind: "describe" }), { generation: 2 });
    await assert.rejects(listenTake(socket, () => {}), { code: "EADDRINUSE" });
    assert.deepEqual(await requestTake(socket, { kind: "describe" }), { generation: 2 }, "a live listener is never unlinked by another Pi startup");
  } finally {
    child.kill("SIGKILL");
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    fs.rmSync(socket, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
