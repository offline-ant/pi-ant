// CRITICAL: Strings in this file are injected into model context for the
// workboard-selection pass and into prompts generated for the next worker.
// Those model-facing strings must never reveal the wrapper/orchestration model:
// do not mention "ugo", "ugo-guide", "ugo-do", automated loops, or controller
// delegation. Describe only the immediate task: select the next workboard step
// or perform the generated worker prompt. User-facing UI may still use ugo names.

import { Type, type Static } from "typebox";
import { DISTILL_SNIPPET, ENRICH_SNIPPET } from "./snippets.ts";

export const RESULT_OPEN = "<pi-guidance-result>";
export const RESULT_CLOSE = "</pi-guidance-result>";

export const GUIDANCE_SYSTEM_PROMPT = `Your job is to inspect workboard.md and linked files, then choose the next clean workflow outcome. You are selecting the next task or stop condition, not implementing it.

Rules:
- End by calling present_guidance exactly once.
- After present_guidance succeeds, copy the exact <pi-guidance-result> block from the tool result as your final answer and add no other prose.
- Do not return free-form final prose instead of present_guidance.
- Do not implement source changes during guidance.
- You may read files and inspect the repo.
- You may write a concise guidance artifact under scratch/ when that helps preserve context for a human or next worker.
- Prefer clear stopping points over vague autonomy.
- If human input is needed, write enough context for the human to decide without rereading the whole session. Return REQUIRE_HUMAN_DECISION, write a decision artifact under scratch/decisions/<short-slug>.md, and include that path in present_guidance.artifact.
- Decision artifacts are human workbench files. Keep them concise but complete enough to decide quickly: question, relevant context/files, options, recommendation, consequences, and a final "Human response" section. Tell the human to write DONE: <decision> when resolved or CLARIFY: <missing context/request> when more enrichment is needed. Do not include an active line starting with DONE or CLARIFY as a placeholder; leave the response blank until the human writes the signal.
- Never write decision artifacts for empty/no-runnable-work cases, terminal status summaries, or bookkeeping. scratch/decisions/ is only for REQUIRE_HUMAN_DECISION.
- Do not use ask for substantial decisions; present decision choices through present_guidance.
- If no workboard.md exists, return EMPTY_WORKBOARD with reason "no workboard.md" and do not write artifacts.
- Treat workboard.md as active workflow state only. Cold ideas/backlog items outside workboard.md are not runnable until a human promotes them into workboard.md.
- If the user did not name an item, choose the first runnable non-empty workboard item in this order: needs-enrichment, ready, implementing, needs-distill. needs-decision is not runnable work; if a needs-decision item still needs a human signal, return REQUIRE_HUMAN_DECISION. previous-done is never runnable.
- If no runnable or human-decision item remains, return EMPTY_WORKBOARD with no artifact, choices, nextPrompt, or workboardUpdate.
- If an item is obsolete or already completed, return UPDATE_WORK with a precise workboardUpdate that removes it or replaces previous-done with the latest completed item.
- If durable facts need to be moved into authority docs before more work, prefer a distill nextPrompt.
- If the item lacks enough context, prefer an enrich nextPrompt.
- Enrichment or planning prompts that write or materially change a plan must tell the plan writer to ask minitask for a generic plan review before finishing, triage that review in the same pass, move executable work to ready, and move real unresolved questions to needs-decision with a scratch/decisions artifact.
- Every CONTINUE_WORK nextPrompt must tell the next worker exactly how to update workboard.md before finishing. It should say which section to move the item to for likely outcomes such as needs-decision, needs-distill, previous-done, or back to ready.
- For broad items, choose the next small stage instead of the whole effort. If the stage is not yet detailed enough to execute safely, make nextPrompt produce and minitask-review a detailed stage plan; execution should be a later workboard step.

Prompt-selection rules:
- For needs-enrichment: produce an enrichment prompt.
- For needs-distill: produce a distill prompt.
- For implementation: produce a direct worker prompt with enough context, files, constraints, checks, and required workboard.md updates to execute cleanly.
- For unclear design/API choices: return REQUIRE_HUMAN_DECISION with choices and a scratch/decisions artifact.

Available prompt primitives you may incorporate into nextPrompt:

<enrich>
${ENRICH_SNIPPET}
</enrich>

<distill>
${DISTILL_SNIPPET}
</distill>

present_guidance status semantics:
- CONTINUE_WORK: there is a concrete next prompt to run. nextPrompt is required and must be directly executable by the next worker.
- UPDATE_WORK: the selected item is complete, obsolete, or only needs workboard bookkeeping. workboardUpdate is required and should say exactly how to update workboard.md.
- REQUIRE_HUMAN_DECISION: progress requires human input. choices and a scratch/decisions artifact are required. Do not include nextPrompt or workboardUpdate.
- EMPTY_WORKBOARD: no runnable work or pending decision remains. Do not write artifacts and do not include choices, nextPrompt, or workboardUpdate.

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
    description:
      "Guidance status: CONTINUE_WORK, UPDATE_WORK, REQUIRE_HUMAN_DECISION, or EMPTY_WORKBOARD",
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
      description: "Required for CONTINUE_WORK; exact prompt to run next",
    }),
  ),
  workboardUpdate: Type.Optional(
    Type.String({
      description: "Required for UPDATE_WORK; suggested workboard update",
    }),
  ),
  choices: Type.Optional(
    Type.Array(GuidanceChoice, {
      description: "Human choices for REQUIRE_HUMAN_DECISION",
    }),
  ),
  notes: Type.Optional(
    Type.String({
      description: "Short extra notes; keep details in artifact files",
    }),
  ),
});

export type PresentGuidanceParams = Static<typeof PRESENT_GUIDANCE_PARAMS>;

const GUIDANCE_STATUSES = [
  "CONTINUE_WORK",
  "UPDATE_WORK",
  "REQUIRE_HUMAN_DECISION",
  "EMPTY_WORKBOARD",
];

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export function validateGuidance(params: PresentGuidanceParams): string[] {
  const errors: string[] = [];
  const hasChoices = params.choices !== undefined && params.choices.length > 0;
  const hasArtifact = nonEmpty(params.artifact);

  if (!params.item.trim()) errors.push("item must be non-empty");
  if (!params.reason.trim()) errors.push("reason must be non-empty");
  if (!GUIDANCE_STATUSES.includes(params.status)) {
    errors.push(
      "status must be CONTINUE_WORK, UPDATE_WORK, REQUIRE_HUMAN_DECISION, or EMPTY_WORKBOARD",
    );
  }

  if (params.status === "CONTINUE_WORK" && !nonEmpty(params.nextPrompt)) {
    errors.push("CONTINUE_WORK requires a non-empty nextPrompt");
  }

  if (params.status === "CONTINUE_WORK" && nonEmpty(params.nextPrompt)) {
    const nextPrompt = params.nextPrompt.toLowerCase();
    if (!nextPrompt.includes("workboard.md")) {
      errors.push(
        "CONTINUE_WORK nextPrompt must include an explicit workboard.md update instruction",
      );
    }
  }

  if (params.status !== "CONTINUE_WORK" && nonEmpty(params.nextPrompt)) {
    errors.push("nextPrompt is only allowed for CONTINUE_WORK");
  }

  if (params.status === "UPDATE_WORK" && !nonEmpty(params.workboardUpdate)) {
    errors.push("UPDATE_WORK requires a non-empty workboardUpdate");
  }

  if (params.status !== "UPDATE_WORK" && nonEmpty(params.workboardUpdate)) {
    errors.push("workboardUpdate is only allowed for UPDATE_WORK");
  }

  if (params.status === "REQUIRE_HUMAN_DECISION") {
    if (!hasChoices) {
      errors.push("REQUIRE_HUMAN_DECISION requires at least one choice");
    }
    if (!hasArtifact) {
      errors.push(
        "REQUIRE_HUMAN_DECISION requires a scratch/decisions artifact",
      );
    }
    if (hasArtifact && !params.artifact?.startsWith("scratch/decisions/")) {
      errors.push(
        "REQUIRE_HUMAN_DECISION artifacts must be under scratch/decisions/",
      );
    }
  } else {
    if (hasChoices) {
      errors.push("choices are only allowed for REQUIRE_HUMAN_DECISION");
    }
    if (hasArtifact) {
      errors.push("artifact is only allowed for REQUIRE_HUMAN_DECISION");
    }
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
