import { ensureTauServer } from "../tau-server.ts";

const server = await ensureTauServer();
process.stdout.write(JSON.stringify({ pid: server.pid, started: server.started }));
