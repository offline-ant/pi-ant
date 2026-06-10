/**
 * Context Explorer — overview of files in context.
 *
 * Command: /context-explorer
 *   Starts an HTTP server on port 41789, serving viewer.html + viewer.js
 *   from the extension directory + /api/data endpoint, then opens browser.
 * Command: /context-explorer-stop
 *   Stops the server.
 *
 * Viewer shows:
 *   - All files in the project directory (cwd)
 *   - Which files have been read by the agent in the current session
 *     (only post-last-compaction reads count)
 *   - Color-coded by read coverage percentage
 *   - Clickable importance levels (0-9) saved to localStorage
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Constants ─────────────────────────────────────────────────────

const SESSIONS_DIR = path.resolve(
  process.env.HOME || "/home/claude",
  ".pi/agent/sessions",
);

const FIXED_PORT = 41789;

const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", ".pi", "target", ".turbo", "coverage", ".nyc_output",
  ".cache", ".yarn", ".svelte-kit", ".astro",
]);

const SKIP_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico", ".svg",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".pdf", ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".db", ".sqlite", ".sqlite3",
  ".o", ".obj", ".class", ".pyc", ".pyo",
  ".lockb",
]);

const MAX_FILES_FOR_API = 5000;

// Resolve static files relative to this extension's directory
const STATIC_DIR = __dirname;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// ── Helpers ───────────────────────────────────────────────────────

function findBrowser(): string | null {
  for (const cmd of ["xdg-open", "open"]) {
    try {
      execSync(`which ${cmd}`, { stdio: "ignore" });
      return cmd;
    } catch { /* try next */ }
  }
  return null;
}

/** Walk project directory, returning relative file paths with sizes. */
function walkFiles(root: string): { path: string; size: number }[] {
  const results: { path: string; size: number }[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && results.length < MAX_FILES_FOR_API) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) {
          queue.push(path.join(dir, e.name));
        }
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SKIP_EXTENSIONS.has(ext)) {
          const full = path.join(dir, e.name);
          let size = 0;
          try { size = fs.statSync(full).size; } catch { /* skip */ }
          results.push({ path: path.relative(root, full), size });
        }
      }
    }
  }
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * Parse the current session file and collect read calls after the last compaction.
 * Returns a map of absolute path → read coverage percent (0-100).
 */
function collectReads(sessionFile: string): Map<string, number> {
  const reads: Map<string, { offsets: [number, number][] }> = new Map();

  let lines: string[];
  try {
    lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
  } catch {
    return new Map();
  }

  // Find the last compaction entry line index
  let lastCompactionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]!);
      if (entry.type === "compaction") {
        lastCompactionIdx = i;
      }
    } catch { /* skip malformed */ }
  }

  // Collect read calls from assistant messages after last compaction
  for (let i = lastCompactionIdx + 1; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]!);
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg || msg.role !== "assistant") continue;
      if (!Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (typeof block !== "object" || block === null) continue;
        if (block.type !== "toolCall") continue;
        if (block.name !== "read") continue;

        const args = block.arguments || {};
        const filePath: string | null = typeof args.path === "string" ? args.path : null;
        if (!filePath) continue;

        const abs = path.isAbsolute(filePath) ? filePath : path.resolve(SESSIONS_DIR, filePath);
        const offset: number = typeof args.offset === "number" ? args.offset : 0;
        const limit: number = typeof args.limit === "number" ? args.limit : Infinity;

        const existing = reads.get(abs);
        if (existing) {
          existing.offsets.push([offset, limit]);
        } else {
          reads.set(abs, { offsets: [[offset, limit]] });
        }
      }
    } catch { /* skip malformed */ }
  }

  // Calculate coverage percentages
  const result = new Map<string, number>();
  for (const [absPath, { offsets }] of reads) {
    let fileSize: number;
    try {
      fileSize = fs.statSync(absPath).size;
    } catch {
      continue;
    }
    if (fileSize === 0) {
      result.set(absPath, 100);
      continue;
    }

    const sorted = offsets
      .map(([o, l]) => [o, Math.min(l, fileSize - o)] as [number, number])
      .filter(([, l]) => l > 0)
      .sort((a, b) => a[0] - b[0]);

    if (sorted.length === 0) continue;

    let covered = 0;
    let currentStart = sorted[0]![0];
    let currentEnd = sorted[0]![0] + sorted[0]![1];

    for (let i = 1; i < sorted.length; i++) {
      const [s, l] = sorted[i]!;
      if (s <= currentEnd) {
        currentEnd = Math.max(currentEnd, s + l);
      } else {
        covered += currentEnd - currentStart;
        currentStart = s;
        currentEnd = s + l;
      }
    }
    covered += currentEnd - currentStart;

    const pct = Math.min(100, Math.round((covered / fileSize) * 100));
    result.set(absPath, pct);
  }

  return result;
}

// ── HTTP server ───────────────────────────────────────────────────

interface ServerState {
  server: http.Server;
  port: number;
  cwd: string;
  sessionFile: string;
}

function serveStaticFile(
  filePath: string,
  res: http.ServerResponse,
): void {
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const ct = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": ct,
      "Content-Length": String(content.length),
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ServerState,
): void {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // API
  if (req.url === "/api/data") {
    try {
      const reads = collectReads(state.sessionFile);
      const files = walkFiles(state.cwd);
      const enriched = files.map((f) => {
        const absPath = path.resolve(state.cwd, f.path);
        return { path: f.path, size: f.size, readPct: reads.get(absPath) ?? 0 };
      });
      const body = JSON.stringify({
        cwd: state.cwd,
        sessionFile: state.sessionFile,
        files: enriched,
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    } catch (err: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static files
  if (req.url === "/" || req.url === "/viewer.html") {
    serveStaticFile(path.join(STATIC_DIR, "viewer.html"), res);
    return;
  }
  if (req.url === "/viewer.js") {
    serveStaticFile(path.join(STATIC_DIR, "viewer.js"), res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

// ── Extension ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let state: ServerState | null = null;

  function stopServer() {
    if (state) {
      state.server.close();
      state = null;
    }
  }

  pi.on("session_shutdown", () => stopServer());

  pi.registerCommand("context-explorer", {
    description: "Start context explorer web server on port 41789 + open browser",
    async handler(_args, ctx) {
      stopServer();

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No session file — run in a saved session", "error");
        return;
      }
      if (!fs.existsSync(sessionFile)) {
        ctx.ui.notify("Session file not found: " + sessionFile, "error");
        return;
      }

      const port = FIXED_PORT;
      const cwd = ctx.cwd;
      const server = http.createServer((req, res) =>
        handleRequest(req, res, { server, port, cwd, sessionFile }),
      );
      const s: ServerState = { server, port, cwd, sessionFile };

      try {
        await new Promise<void>((resolve, reject) => {
          server.listen(port, "0.0.0.0", () => resolve());
          server.on("error", reject);
        });
      } catch (err: any) {
        if (err.code === "EADDRINUSE") {
          ctx.ui.notify(
            `Port ${port} is in use. Stop the existing server first (/context-explorer-stop)`,
            "error",
          );
        } else {
          ctx.ui.notify(`Failed to start server: ${err.message}`, "error");
        }
        return;
      }

      state = s;
      const url = `http://127.0.0.1:${port}`;

      const browserCmd = findBrowser();
      let browserOk = false;
      if (browserCmd) {
        try {
          execSync(`${browserCmd} "${url}"`, { stdio: "ignore", timeout: 3000 });
          browserOk = true;
        } catch { /* headless or no display */ }
      }

      const files = walkFiles(cwd);
      ctx.ui.notify(
        `Context Explorer: ${url} (${files.length} files in ${cwd})` +
          (browserOk ? " — browser opened" : ""),
        "info",
      );
    },
  });

  pi.registerCommand("context-explorer-stop", {
    description: "Stop the context explorer web server",
    async handler(_args, ctx) {
      if (state) {
        stopServer();
        ctx.ui.notify("Context Explorer stopped", "info");
      } else {
        ctx.ui.notify("Context Explorer is not running", "info");
      }
    },
  });
}
