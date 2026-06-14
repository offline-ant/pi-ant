import { Type, type Static } from "typebox";
import {
  DISTILL_SNIPPET,
  ENRICH_SNIPPET,
  MINI_REVIEW_SUFFIX,
  MINIVISE_SNIPPET,
} from "./snippets.ts";

export const RESULT_OPEN = "<pi-guidance-result>";
export const RESULT_CLOSE = "</pi-guidance-result>";

export const GUIDANCE_SYSTEM_PROMPT = `You are running in PI_GUIDANCE mode.

Your job is to inspect workboard.md and linked files, then compile the next clean workflow step. You are an outer guidance pass, not the implementation worker.

Rules:
- End by calling present_guidance exactly once.
- After present_guidance succeeds, copy the exact <pi-guidance-result> block from the tool result as your final answer and add no other prose.
- Do not return free-form final prose instead of present_guidance.
- Do not implement source changes during guidance.
- You may read files and inspect the repo.
- You may write a concise guidance artifact under scratch/ when that helps preserve context for a human or next worker.
- Prefer clear stopping points over vague autonomy.
- If human input is needed, write enough context for the human to decide without rereading the whole session. For decision stalls, write a decision artifact under scratch/decisions/<short-slug>.md and include that path in present_guidance.artifact.
- Decision artifacts are human workbench files. Keep them concise but complete enough to decide quickly: question, relevant context/files, options, recommendation, consequences, and a final "Human response" section. Tell the human to write DONE: <decision> when resolved or CLARIFY: <missing context/request> when more enrichment is needed. Do not include an active line starting with DONE or CLARIFY as a placeholder; leave the response blank until the human writes the signal.
- Do not use ask for substantial decisions; present decision choices through present_guidance.
- If no workboard.md exists, return STALLED with reason "no workboard.md".
- If the user did not name an item, choose the first runnable non-empty workboard item in this order: needs-enrichment, ready, implementing, needs-review, needs-distill. needs-decision is not runnable without human input. done is never runnable.
- If an item is obsolete or already completed, return DONE with a precise workboardUpdate.
- If durable facts need to be moved into authority docs before more work, prefer a distill nextPrompt.
- If the item lacks enough context, prefer an enrich nextPrompt.
- Every CONTINUE nextPrompt must tell the next worker exactly how to update workboard.md before finishing. It should say which section to move the item to for likely outcomes such as needs-decision, needs-distill, needs-review, done, or back to ready.

Prompt-selection rules:
- For needs-enrichment: produce an enrichment prompt.
- For needs-review: usually produce a mini-review prompt.
- For needs-distill: produce a distill prompt.
- For a large clear implementation plan: produce a minivise supervisor prompt.
- For a small focused implementation: produce a direct do prompt.
- For unclear design/API choices: return STALLED with choices, not minivise.
- Do not use minivise just to avoid understanding the task; the do prompt must include enough context for fresh minitasks.

Available prompt primitives you may incorporate into nextPrompt:

<enrich>
${ENRICH_SNIPPET}
</enrich>

<distill>
${DISTILL_SNIPPET}
</distill>

<mini-review>
${MINI_REVIEW_SUFFIX}
</mini-review>

<minivise>
${MINIVISE_SNIPPET}
</minivise>

present_guidance status semantics:
- CONTINUE: there is a concrete next prompt to run. nextPrompt is required and must be directly executable by pi -p.
- STALLED: do not continue automatically. Use for no runnable item, missing context that requires human input, real blockers, or design decisions.
- DONE: selected item is complete or obsolete. workboardUpdate is required and should say exactly how to remove or move the item.

Keep nextPrompt specific: include relevant files, constraints, what to do, checks/reports expected when relevant, and the required workboard.md update. Do not say only "continue" or "do the next step".`;

const GuidanceChoice = Type.Object({
  label: Type.String({ description: "Short option label" }),
  description: Type.Optional(
    Type.String({ description: "Enough context to understand the choice" }),
  ),
  recommended: Type.Optional(
    Type.Boolean({ description: "Whether this option is recommended" }),
  ),
});

export const PRESENT_GUIDANCE_PARAMS = Type.Object({
  status: Type.String({
    description: "Guidance status: CONTINUE, STALLED, or DONE",
  }),
  item: Type.String({
    description: "The workboard item this guidance applies to",
  }),
  reason: Type.String({ description: "Why this status was selected" }),
  artifact: Type.Optional(
    Type.String({ description: "Optional guidance artifact path" }),
  ),
  nextPrompt: Type.Optional(
    Type.String({
      description: "Required for CONTINUE; exact prompt to run next",
    }),
  ),
  workboardUpdate: Type.Optional(
    Type.String({
      description: "Required for DONE; suggested workboard update",
    }),
  ),
  choices: Type.Optional(
    Type.Array(GuidanceChoice, {
      description: "Human choices for STALLED decisions",
    }),
  ),
  notes: Type.Optional(
    Type.String({
      description: "Short extra notes; keep details in artifact files",
    }),
  ),
});

export type PresentGuidanceParams = Static<typeof PRESENT_GUIDANCE_PARAMS>;

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export function validateGuidance(params: PresentGuidanceParams): string[] {
  const errors: string[] = [];

  if (!params.item.trim()) errors.push("item must be non-empty");
  if (!params.reason.trim()) errors.push("reason must be non-empty");
  if (!["CONTINUE", "STALLED", "DONE"].includes(params.status)) {
    errors.push("status must be CONTINUE, STALLED, or DONE");
  }

  if (params.status === "CONTINUE" && !nonEmpty(params.nextPrompt)) {
    errors.push("CONTINUE requires a non-empty nextPrompt");
  }

  if (
    params.status === "CONTINUE" &&
    nonEmpty(params.nextPrompt) &&
    !params.nextPrompt.toLowerCase().includes("workboard.md")
  ) {
    errors.push(
      "CONTINUE nextPrompt must include an explicit workboard.md update instruction",
    );
  }

  if (params.status !== "CONTINUE" && nonEmpty(params.nextPrompt)) {
    errors.push("nextPrompt is only allowed for CONTINUE");
  }

  if (params.status === "DONE" && !nonEmpty(params.workboardUpdate)) {
    errors.push("DONE requires a non-empty workboardUpdate");
  }

  if (
    params.status === "STALLED" &&
    params.reason.toLowerCase().includes("decision") &&
    (!params.choices || params.choices.length === 0)
  ) {
    errors.push("STALLED decision cases require at least one choice");
  }

  if (
    params.status === "STALLED" &&
    params.choices &&
    params.choices.length > 0 &&
    !nonEmpty(params.artifact)
  ) {
    errors.push(
      "STALLED decision cases with choices require a scratch/decisions artifact",
    );
  }

  if (
    params.status === "STALLED" &&
    nonEmpty(params.artifact) &&
    !params.artifact?.startsWith("scratch/decisions/")
  ) {
    errors.push("STALLED decision artifacts must be under scratch/decisions/");
  }

  if (params.choices) {
    for (let i = 0; i < params.choices.length; i++) {
      if (!params.choices[i]?.label.trim()) {
        errors.push(`choices[${i}].label must be non-empty`);
      }
    }
  }

  return errors;
}

export function formatGuidanceResult(params: PresentGuidanceParams): string {
  return `${RESULT_OPEN}\n${JSON.stringify(params, null, 2)}\n${RESULT_CLOSE}`;
}
