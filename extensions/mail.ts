import { isAbsolute, join } from "node:path";
import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	buildMailMessage,
	loadMailConfig,
	sendMail,
	validateMailContent,
} from "./mail-core.ts";

const SEND_MAIL_PARAMS = Type.Object({
	subject: Type.String({
		description:
			"Plain-text mail subject. Line breaks are not allowed; maximum 256 UTF-8 bytes.",
		minLength: 1,
		maxLength: 256,
	}),
	body: Type.String({
		description: "Plain-text mail body. Maximum 64 KiB as UTF-8.",
		minLength: 1,
		maxLength: 65_536,
	}),
});

type SendMailParams = Static<typeof SEND_MAIL_PARAMS>;

interface SendMailDetails {
	cancelled: boolean;
	messageId?: string;
	recipients: string[];
	hostname?: string;
}

function configPath(): string {
	const override = process.env.PI_MAIL_CONFIG;
	if (!override) return join(getAgentDir(), "mail.json");
	if (!isAbsolute(override))
		throw new Error("PI_MAIL_CONFIG must be an absolute path.");
	return override;
}

function cancelledResult(recipients: string[], reason: string) {
	return {
		content: [{ type: "text" as const, text: reason }],
		details: { cancelled: true, recipients } satisfies SendMailDetails,
	};
}

export default function (pi: ExtensionAPI) {
	let sendInProgress = false;

	pi.registerTool({
		name: "send_mail",
		label: "Send Mail",
		description:
			"Send a confirmed plain-text email through the implicit-TLS SMTP account configured in the external mail.json file. " +
			"Recipients and sender are fixed by configuration and cannot be supplied by the model. The user reviews the complete body and confirms every send. " +
			"Messages are limited to a 256-byte subject and 64 KiB body.",
		promptSnippet:
			"Send a user-confirmed plain-text email to externally configured recipients",
		promptGuidelines: [
			"Use send_mail only when the user asks to send an email or when email delivery is clearly required; never send status mail automatically.",
		],
		parameters: SEND_MAIL_PARAMS,
		async execute(_toolCallId, params: SendMailParams, signal, onUpdate, ctx) {
			if (sendInProgress)
				throw new Error(
					"Another send_mail call is already awaiting confirmation or delivery.",
				);
			sendInProgress = true;
			try {
				validateMailContent(params.subject, params.body);
				const config = await loadMailConfig(configPath());
				if (!ctx.hasUI) {
					throw new Error(
						"send_mail requires interactive confirmation and is disabled in non-interactive modes.",
					);
				}
				if (signal?.aborted)
					return cancelledResult(
						config.to,
						"Mail was not sent because the operation was cancelled.",
					);

				const reviewedBody = await ctx.ui.editor(
					`Review mail body for ${config.to.join(", ")}`,
					params.body,
				);
				if (reviewedBody === undefined || signal?.aborted) {
					return cancelledResult(
						config.to,
						"Mail was not sent because review was cancelled.",
					);
				}
				validateMailContent(params.subject, reviewedBody);

				const bodyBytes = Buffer.byteLength(reviewedBody, "utf8");
				const confirmed = await ctx.ui.confirm(
					"Send email?",
					[
						`From: ${config.from}`,
						`To: ${config.to.join(", ")}`,
						`Subject: ${params.subject}`,
						`Body: ${bodyBytes} UTF-8 bytes (reviewed in the editor)`,
					].join("\n"),
					{ signal },
				);
				if (!confirmed || signal?.aborted) {
					return cancelledResult(
						config.to,
						"Mail was not sent because confirmation was declined or cancelled.",
					);
				}

				const message = buildMailMessage(config, params.subject, reviewedBody);
				onUpdate?.({
					content: [
						{ type: "text", text: `Sending mail to ${config.to.join(", ")}…` },
					],
					details: {},
				});
				await sendMail(config, message, signal);
				return {
					content: [
						{
							type: "text",
							text: `Mail accepted for delivery to ${config.to.join(", ")} (${message.messageId}).`,
						},
					],
					details: {
						cancelled: false,
						messageId: message.messageId,
						recipients: [...config.to],
						hostname: message.hostname,
					} satisfies SendMailDetails,
				};
			} finally {
				sendInProgress = false;
			}
		},
	});
}
