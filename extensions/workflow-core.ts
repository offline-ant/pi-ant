import fs from "node:fs/promises";
import path from "node:path";

export const WORKFLOW_FILE = "workflow.md";

const WORKFLOW_TEMPLATE_URL = new URL("./workflow-template.md", import.meta.url);

export async function readDefaultWorkflowTemplate(): Promise<string> {
  return fs.readFile(WORKFLOW_TEMPLATE_URL, "utf8");
}

export const GUIDANCE_PROTOCOL_PROMPT = `Select the next workboard task or stop condition; do not implement source changes. You may inspect the repository and write a scratch guidance artifact only when needed for a worker or human decision. Follow workflow.md, which may refine selection policy but not this protocol or the present_guidance schema.

Call present_guidance exactly once as the final action. After it succeeds, return its exact <pi-guidance-result> block with no other prose. Invalid combinations are rejected:
- CONTINUE_WORK requires a directly executable nextPrompt containing an explicit workboard.md update instruction.
- UPDATE_WORK requires the exact workboardUpdate and no nextPrompt.
- REQUIRE_HUMAN_DECISION requires choices and an existing scratch/decisions artifact; include neither nextPrompt nor workboardUpdate.
- EMPTY_WORKBOARD permits no artifact, choices, nextPrompt, or workboardUpdate.
If workboard.md is missing, return EMPTY_WORKBOARD with reason "no workboard.md" and write no artifact.`;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export async function ensureWorkflowFile(cwd: string): Promise<boolean> {
  try {
    await fs.writeFile(path.join(cwd, WORKFLOW_FILE), await readDefaultWorkflowTemplate(), {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

export async function readWorkflowFile(cwd: string): Promise<string> {
  return fs.readFile(path.join(cwd, WORKFLOW_FILE), "utf8");
}

export async function ensureAndReadWorkflowFile(cwd: string): Promise<{
  content: string;
  created: boolean;
}> {
  const created = await ensureWorkflowFile(cwd);
  return { content: await readWorkflowFile(cwd), created };
}

export function formatGuidanceSystemPrompt(workflow: string): string {
  return `${GUIDANCE_PROTOCOL_PROMPT}\n\nEditable workflow policy loaded from workflow.md:\n\n<workflow.md>\n${workflow}\n</workflow.md>`;
}
