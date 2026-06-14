import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatGuidanceResult,
  GUIDANCE_SYSTEM_PROMPT,
  PRESENT_GUIDANCE_PARAMS,
  validateGuidance,
} from "./guidance-core.ts";

const GUIDANCE_ENABLED = process.env.PI_GUIDANCE === "true";

export default function (pi: ExtensionAPI) {
  if (!GUIDANCE_ENABLED) return;

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE_SYSTEM_PROMPT}`,
  }));

  pi.on("session_start", async () => {
    let active = pi.getActiveTools();
    if (!active.includes("present_guidance")) active = [...active, "present_guidance"];
    pi.setActiveTools(active);
  });

  pi.registerTool({
    name: "present_guidance",
    label: "Present Guidance",
    description: "Validate and present the final workboard guidance result. After this succeeds, copy the result block exactly as the final answer.",
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
