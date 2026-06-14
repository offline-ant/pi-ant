/**
 * Tweaks — small session-level adjustments and # prompt snippets.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SNIPPETS } from "./snippets.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["#"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
        const query = match?.[1];
        if (query === undefined) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const normalizedQuery = query.toLowerCase();
        const items = SNIPPETS.filter((snippet) =>
          snippet.key.startsWith(normalizedQuery),
        ).map((snippet) => ({
          value: snippet.value,
          label: `#${snippet.key}`,
          description: snippet.description,
        }));

        if (items.length === 0) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        return {
          prefix: `#${query}`,
          items,
        };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));

    let active = pi.getActiveTools();
    // Enable grep (registered but not in the default active set)
    if (!active.includes("grep")) active = [...active, "grep"];
    pi.setActiveTools(active);
  });
}
