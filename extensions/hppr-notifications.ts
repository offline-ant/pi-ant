/**
 * HPPR notifications — best-effort desktop notification when a prompt finishes.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "hppr-notifications-config";
const NOTIFICATION_TITLE = "Pi";
const NOTIFICATION_BODY = "Prompt finished";
const NOTIFICATION_TIMEOUT_MS = 2_000;

type ToggleValue = "on" | "off";
type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

interface HpprNotificationsState {
	enabled: boolean;
}

export interface HpprNotificationCommand {
	command: "sh";
	args: string[];
	timeoutMs: number;
}

export function createHpprNotificationCommand(
	title = NOTIFICATION_TITLE,
	body = NOTIFICATION_BODY,
): HpprNotificationCommand {
	return {
		command: "sh",
		args: [
			"-c",
			[
				"command -v hppr-notification >/dev/null 2>&1 || exit 0",
				'exec hppr-notification send --title "$1" "$2"',
			].join("\n"),
			"hppr-notifications",
			title,
			body,
		],
		timeoutMs: NOTIFICATION_TIMEOUT_MS,
	};
}

export function sendHpprDesktopNotification(
	title = NOTIFICATION_TITLE,
	body = NOTIFICATION_BODY,
	spawnProcess: SpawnProcess = spawn,
): void {
	const notification = createHpprNotificationCommand(title, body);
	let child: ChildProcess;

	try {
		child = spawnProcess(notification.command, notification.args, {
			stdio: "ignore",
		});
	} catch {
		return;
	}

	const timeout = setTimeout(() => {
		if (!child.killed) {
			child.kill("SIGTERM");
		}
	}, notification.timeoutMs);
	timeout.unref();

	child.on("error", () => {
		clearTimeout(timeout);
	});
	child.on("close", () => {
		clearTimeout(timeout);
	});
	child.unref();
}

function isState(value: unknown): value is HpprNotificationsState {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).enabled === "boolean"
	);
}

function normalizeToggleValue(value: string): ToggleValue | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "on" || normalized === "enable" || normalized === "enabled") return "on";
	if (normalized === "off" || normalized === "disable" || normalized === "disabled") return "off";
	return undefined;
}

async function hpprNotificationAvailable(pi: ExtensionAPI): Promise<boolean> {
	try {
		const result = await pi.exec("sh", ["-c", "command -v hppr-notification >/dev/null 2>&1"], {
			timeout: 1_000,
		});
		return result.code === 0;
	} catch {
		return false;
	}
}

export default function hpprNotificationsExtension(pi: ExtensionAPI) {
	let enabled = false;

	function persistState() {
		pi.appendEntry<HpprNotificationsState>(CUSTOM_TYPE, { enabled });
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("hppr", enabled ? "hppr on" : undefined);
	}

	function setEnabled(nextEnabled: boolean, ctx: ExtensionContext) {
		enabled = nextEnabled;
		persistState();
		updateStatus(ctx);
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE && isState(entry.data)) {
				enabled = entry.data.enabled;
			}
		}
		updateStatus(ctx);
	}

	async function showStatus(ctx: ExtensionCommandContext) {
		const available = await hpprNotificationAvailable(pi);
		const suffix = available
			? "hppr-notification available; use `hppr-notification status` for listener state."
			: "hppr-notification not found.";
		ctx.ui.notify(`HPPR notifications ${enabled ? "on" : "off"}; ${suffix}`, available ? "info" : "warning");
	}

	async function showSettings(ctx: ExtensionCommandContext) {
		const items: SettingItem[] = [
			{
				id: "hppr-notifications",
				label: "HPPR notifications",
				currentValue: enabled ? "on" : "off",
				values: ["on", "off"],
			},
		];

		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("HPPR notifications")), 0, 0));

			const settingsList = new SettingsList(
				items,
				3,
				getSettingsListTheme(),
				(_id, newValue) => {
					setEnabled(newValue === "on", ctx);
					ctx.ui.notify(`HPPR notifications ${newValue}`, "info");
				},
				() => done(undefined),
			);

			container.addChild(settingsList);

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	pi.registerCommand("hppr-notifications", {
		description: "Toggle HPPR desktop notifications",
		handler: async (args, ctx) => {
			const value = normalizeToggleValue(args);
			if (value) {
				setEnabled(value === "on", ctx);
				ctx.ui.notify(`HPPR notifications ${value}`, "info");
				return;
			}

			const normalized = args.trim().toLowerCase();
			if (normalized === "toggle") {
				setEnabled(!enabled, ctx);
				ctx.ui.notify(`HPPR notifications ${enabled ? "on" : "off"}`, "info");
				return;
			}

			if (normalized === "status" || normalized === "help") {
				await showStatus(ctx);
				return;
			}

			if (normalized.length > 0) {
				ctx.ui.notify("Usage: /hppr-notifications [on|off|toggle|status]", "warning");
				return;
			}

			if (ctx.hasUI) {
				await showSettings(ctx);
			} else {
				await showStatus(ctx);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("agent_end", async (event) => {
		if (!enabled || event.willRetry) return;
		sendHpprDesktopNotification();
	});
}
