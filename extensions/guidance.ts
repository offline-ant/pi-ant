import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatGuidanceResult,
  PRESENT_GUIDANCE_PARAMS,
  validateGuidance,
} from "./guidance-core.ts";
import {
  ensureAndReadWorkflowFile,
  formatGuidanceSystemPrompt,
  WORKFLOW_FILE,
} from "./workflow-core.ts";

const GUIDANCE_ENABLED = process.env.PI_GUIDANCE === "true";

export default function (pi: ExtensionAPI) {
  if (!GUIDANCE_ENABLED) return;

  pi.on("before_agent_start", async (event, ctx) => {
    const workflow = await ensureAndReadWorkflowFile(ctx.cwd);
    if (workflow.created) {
      ctx.ui.notify(
        `Created ${WORKFLOW_FILE}. Edit it to customize guidance.`,
        "info",
      );
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${formatGuidanceSystemPrompt(workflow.content)}`,
    };
  });

  pi.on("session_start", async () => {
    let active = pi.getActiveTools();
    if (!active.includes("present_guidance")) active = [...active, "present_guidance"];
    pi.setActiveTools(active);
  });

  pi.registerTool({
    name: "present_guidance",
    label: "Present Guidance",
    description: "Submit the final workboard guidance decision. Valid input returns the exact <pi-guidance-result> block to use as the final answer; invalid input throws.",
    parameters: PRESENT_GUIDANCE_PARAMS,
    async execute(_toolCallId, params) {
      const errors = validateGuidance(params);
      if (errors.length > 0) {
        throw new Error(`Invalid guidance output:\n${errors.map((error) => `- ${error}`).join("\n")}`);
      }

      return {
        content: [{ type: "text", text: formatGuidanceResult(params) }],
        details: params,
      };
    },
  });
}
