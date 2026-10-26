/**
 * /init-agents-md — ask the agent to create or update ./AGENTS.md from the
 * standard template in agents-md-template.md.
 */

import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TEMPLATE_URL = new URL("./agents-md-template.md", import.meta.url);

export function initAgentsMdPrompt(template: string): string {
  return `Create or update AGENTS.md in the current directory from the standard template below.

- Fill in the title and the short introduction for this project. If AGENTS.md exists, keep its project-specific rules and replace overlapping generic rules with the template's wording; keep stricter local limits.
- Add only very short project specifics: pointers to the documents and commands that own the truth (README, design docs, check commands), not the information itself. Keep global rules from the template; do not restate them.
- Leave out template rules that clearly do not apply to this project.
- Inspect the project before writing, and show a summary of the result.

<template>
${template}</template>`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("init-agents-md", {
    description: "Create or update AGENTS.md from the standard rules template",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      pi.sendUserMessage(initAgentsMdPrompt(await readFile(TEMPLATE_URL, "utf8")));
    },
  });
}
