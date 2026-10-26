import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = process.env.PI_CODING_AGENT_DIR;
const directory = path.join(root, "tau");
const runtime = path.join(directory, "server.json");
const mode = process.env.FIXTURE_TAU_MODE || "ready";
fs.appendFileSync(path.join(root, "launches.jsonl"), JSON.stringify({
  pid: process.pid, argv: process.argv.slice(2),
  stdin: process.platform === "linux" ? fs.readlinkSync("/proc/self/fd/0") : null,
  env: Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_NESTED", "PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_TARGET",
    "PI_ORCHESTRATION_CONTROL", "PI_ORCHESTRATION_ENDPOINT", "HERDR_SOCKET_PATH", "HERDR_ENV", "HERDR_PANE_ID", "TMUX", "DISPLAY", "TAU_HOST", "TAU_USER", "TAU_PASS"].map((key) => [key, process.env[key] ?? null])),
}) + "\n");
if (mode === "exit") process.exit(2);
const server = http.createServer((req, res) => {
  const authorized = req.headers.authorization === `Basic ${Buffer.from("fixture:private-password").toString("base64")}`;
  res.writeHead(mode === "auth" || !authorized ? 401 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ sessions: [] }));
});
server.listen(0, "127.0.0.1", () => {
  if (mode === "unpublished" || mode === "ignore-term") return;
  const endpoint = `http://fixture:private-password@127.0.0.1:${server.address().port}`;
  fs.writeFileSync(runtime, JSON.stringify({ endpoint, pid: process.pid, browserUrls: ["https://pc:3443/", "https://127.0.0.1:3443"] }), { mode: 0o600 });
  console.log("fixture ready");
});
process.on("SIGTERM", () => {
  if (mode === "ignore-term") return;
  try {
    if (JSON.parse(fs.readFileSync(runtime, "utf8")).pid === process.pid) fs.unlinkSync(runtime);
  } catch {}
  server.close(() => process.exit(0));
});
