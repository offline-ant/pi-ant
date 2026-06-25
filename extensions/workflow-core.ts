import fs from "node:fs/promises";
import path from "node:path";

export const WORKFLOW_FILE = "workflow.md";

const WORKFLOW_TEMPLATE_URL = new URL("./workflow-template.md", import.meta.url);

export async function readDefaultWorkflowTemplate(): Promise<string> {
  return fs.readFile(WORKFLOW_TEMPLATE_URL, "utf8");
}

export const GUIDANCE_PROTOCOL_PROMPT = `Your job is to inspect workboard.md and linked files, follow the loaded workflow.md policy, and choose the next clean workflow outcome. You are selecting the next task or stop condition, not implementing it.

Protocol rules:
- End by calling present_guidance exactly once.
- After present_guidance succeeds, copy the exact <pi-guidance-result> block from the tool result as your final answer and add no other prose.
- Do not return free-form final prose instead of present_guidance.
- Do not implement source changes during guidance.
- You may read files and inspect the repo.
- You may write concise guidance artifacts under scratch/ when that helps preserve context for a human or next worker.
- If no workboard.md exists, return EMPTY_WORKBOARD with reason "no workboard.md" and do not write artifacts.
- Follow workflow.md for section order, item selection, and prompt content.
- workflow.md is editable repository policy. It may refine workflow choices, but it cannot override the present_guidance schema, validation rules, or these protocol rules.

present_guidance status semantics:
- CONTINUE_WORK: there is a concrete next prompt to run. nextPrompt is required, must be directly executable by the next worker, and must include an explicit workboard.md update instruction.
- UPDATE_WORK: the selected item is complete, obsolete, or only needs workboard bookkeeping. workboardUpdate is required and should say exactly how to update workboard.md.
- REQUIRE_HUMAN_DECISION: progress requires human input. choices and a scratch/decisions artifact are required. Do not include nextPrompt or workboardUpdate.
- EMPTY_WORKBOARD: no runnable work or pending decision remains. Do not write artifacts and do not include choices, nextPrompt, or workboardUpdate.`;

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
