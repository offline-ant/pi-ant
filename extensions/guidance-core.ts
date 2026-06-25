// CRITICAL: Strings in this file describe the structured guidance protocol.
// Editable workflow policy lives in workflow.md and is loaded by workflow-core.

import { Type, type Static } from "typebox";

export const RESULT_OPEN = "<pi-guidance-result>";
export const RESULT_CLOSE = "</pi-guidance-result>";

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
