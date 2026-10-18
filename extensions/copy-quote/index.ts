import { copyToClipboard, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { extractQuotes } from "./markdown.ts";

export async function copyQuote(
  ctx: ExtensionCommandContext,
  copy: (text: string) => Promise<void> = copyToClipboard,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/copy-quote requires terminal interactive mode", "error");
    return;
  }

  const branch = ctx.sessionManager.getBranch();
  const latest = branch.findLast((entry) => entry.type === "message"
    && entry.message.role === "assistant" && entry.message.stopReason === "stop");
  if (!latest || latest.type !== "message" || latest.message.role !== "assistant") {
    ctx.ui.notify("No completed assistant response on this branch", "info");
    return;
  }

  try {
    const quotes = latest.message.content.flatMap((part) => part.type === "text" ? extractQuotes(part.text) : []);
    if (quotes.length === 0) {
      ctx.ui.notify("No blockquotes in the latest completed assistant response", "info");
      return;
    }

    let selected = quotes[0];
    if (quotes.length > 1) {
      const options = quotes.map((quote, index) => `${index + 1}. ${quote.replace(/\s+/g, " ").trim().slice(0, 120)}`);
      const choice = await ctx.ui.select("Copy quote", options);
      if (choice === undefined) return;
      const index = options.indexOf(choice);
      if (index < 0) return;
      selected = quotes[index];
    }
    await copy(selected);
    ctx.ui.notify("Quote copied to clipboard", "info");
  } catch (error) {
    ctx.ui.notify(`Could not copy quote: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("copy-quote", {
    description: "Copy a blockquote from the latest completed assistant response without quote markers",
    handler: async (_args, ctx) => copyQuote(ctx),
  });
}
