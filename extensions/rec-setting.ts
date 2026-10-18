import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Global dictation backend used by Tau's microphone button; audio never passes through Pi. */
export type VoiceBackend = "claude" | "local";
export interface VoiceSetting { backend: VoiceBackend; localUrl?: string }

export const DEFAULT_LOCAL_URL = "http://127.0.0.1:8090";
const BACKENDS: VoiceBackend[] = ["claude", "local"];
const USAGE = "Usage: /rec-setting [claude|local [url]|status]. Omit arguments to pick.";

export function voiceSettingFile(): string { return path.join(getAgentDir(), "voice.json"); }

function parseLocalUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid local URL: ${value}`); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error(`Local URL must be a credential-free http(s) base URL: ${value}`);
  }
  return url.href.replace(/\/$/, "");
}

/** Missing file selects Claude; malformed content is an error, never a silent default. */
export function readVoiceSetting(file = voiceSettingFile()): VoiceSetting {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { backend: "claude" };
    throw error;
  }
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || !("backend" in data) || !BACKENDS.includes(data.backend as VoiceBackend)) {
    throw new Error(`Invalid ${file}: expected {"backend":"claude"|"local","localUrl"?:string}.`);
  }
  const setting: VoiceSetting = { backend: data.backend as VoiceBackend };
  if ("localUrl" in data && data.localUrl !== undefined) {
    if (typeof data.localUrl !== "string") throw new Error(`Invalid ${file}: localUrl must be a string.`);
    setting.localUrl = parseLocalUrl(data.localUrl);
  }
  return setting;
}

function writeVoiceSetting(setting: VoiceSetting, file = voiceSettingFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(setting)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function probe(url: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? "answering" : `answering with HTTP ${response.status}`;
  } catch (error) {
    return `not answering (${error instanceof Error ? error.message : String(error)})`;
  }
}

export function registerRecSetting(pi: ExtensionAPI, fetchImpl: typeof fetch = fetch): void {
  async function report(ctx: ExtensionCommandContext, prefix = ""): Promise<void> {
    const file = voiceSettingFile();
    let text: string;
    let level: "info" | "error" = "info";
    try {
      const setting = readVoiceSetting(file);
      if (setting.backend === "claude") text = "Dictation backend: claude (native Claude login).";
      else {
        const url = setting.localUrl ?? DEFAULT_LOCAL_URL;
        text = `Dictation backend: local ${url} — ${await probe(url, fetchImpl)}.`;
      }
      text += ` Global setting in ${file}${fs.existsSync(file) ? "" : " (absent: default)"}.`;
    } catch (error) {
      text = error instanceof Error ? error.message : String(error);
      level = "error";
    }
    text = prefix + text;
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else pi.sendMessage({ customType: "pi-ant:rec-setting-status", content: text, display: true });
  }

  pi.registerCommand("rec-setting", {
    description: "Pick the global dictation backend: claude, local [url], or status",
    getArgumentCompletions(prefix) {
      return ["claude", "local", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const [choice = "", url, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (choice === "status" && !url) { await report(ctx); return; }
      let backend: string | undefined = choice;
      if (!backend) backend = await ctx.ui.select("Dictation backend", BACKENDS);
      if (!backend) return;
      if (!BACKENDS.includes(backend as VoiceBackend) || extra.length || (url && backend !== "local")) throw new Error(USAGE);
      // Keep an explicit local URL across backend changes; a malformed file is replaced.
      let localUrl: string | undefined;
      try { localUrl = readVoiceSetting().localUrl; } catch {}
      if (url) localUrl = parseLocalUrl(url);
      writeVoiceSetting({ backend: backend as VoiceBackend, ...(localUrl ? { localUrl } : {}) });
      await report(ctx, "Saved. ");
    },
  });
}

export default function recSettingExtension(pi: ExtensionAPI): void { registerRecSetting(pi); }
