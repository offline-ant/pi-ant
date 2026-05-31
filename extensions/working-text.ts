/**
 * Working text — show the streaming working status without a spinner.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWorkingMessage("Working...");
		ctx.ui.setWorkingIndicator({ frames: [] });
	});
}
