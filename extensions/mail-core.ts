import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import {
	type ConnectionOptions,
	connect as connectTls,
	type TLSSocket,
} from "node:tls";

const CONFIG_KEYS = new Set([
	"host",
	"port",
	"username",
	"password",
	"from",
	"to",
]);
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_USERNAME_BYTES = 512;
const MAX_PASSWORD_BYTES = 4096;
const MAX_SUBJECT_BYTES = 256;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECIPIENTS = 10;
const MAX_SMTP_LINE_BYTES = 4096;
const MAX_SMTP_BUFFER_BYTES = 64 * 1024;
const SMTP_TIMEOUT_MS = 30_000;
const HEADER_ENCODED_WORD_BYTES = 39;

const DNS_NAME_PATTERN =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const MAILBOX_PATTERN =
	/^([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@(.+)$/;

export interface MailConfig {
	host: string;
	port: number;
	username: string;
	password: string;
	from: string;
	to: string[];
}

export interface MailMessage {
	data: string;
	messageId: string;
	hostname: string;
}

export interface SmtpResponse {
	code: number;
	lines: string[];
}

export interface SmtpTransport {
	readLine(signal?: AbortSignal): Promise<string>;
	write(data: string, signal?: AbortSignal): Promise<void>;
	close(): void;
}

export class DeliveryOutcomeUnknownError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeliveryOutcomeUnknownError";
	}
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function requireString(value: unknown, name: string, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Mail configuration '${name}' must be a non-empty string.`);
	}
	if (value.includes("\0"))
		throw new Error(`Mail configuration '${name}' must not contain NUL.`);
	if (byteLength(value) > maxBytes)
		throw new Error(`Mail configuration '${name}' is too long.`);
	return value;
}

function normalizeMailbox(value: unknown, name: string): string {
	const mailbox = requireString(value, name, 320);
	if (/[\r\n]/.test(mailbox))
		throw new Error(
			`Mail configuration '${name}' must not contain line breaks.`,
		);
	const match = MAILBOX_PATTERN.exec(mailbox);
	if (!match || !match[2] || !DNS_NAME_PATTERN.test(match[2])) {
		throw new Error(
			`Mail configuration '${name}' must be a plain ASCII email address.`,
		);
	}
	return `${match[1]}@${match[2].toLowerCase()}`;
}

function validateConfig(value: unknown): MailConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Mail configuration must be a JSON object.");
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!CONFIG_KEYS.has(key))
			throw new Error(`Unknown mail configuration key '${key}'.`);
	}
	for (const key of CONFIG_KEYS) {
		if (!(key in record))
			throw new Error(`Missing mail configuration key '${key}'.`);
	}

	const host = requireString(record.host, "host", 253).toLowerCase();
	if (!DNS_NAME_PATTERN.test(host)) {
		throw new Error(
			"Mail configuration 'host' must be a DNS hostname without a scheme or path.",
		);
	}
	if (
		!Number.isInteger(record.port) ||
		(record.port as number) < 1 ||
		(record.port as number) > 65535
	) {
		throw new Error(
			"Mail configuration 'port' must be an integer from 1 through 65535.",
		);
	}
	const username = requireString(
		record.username,
		"username",
		MAX_USERNAME_BYTES,
	);
	if (/[\r\n]/.test(username))
		throw new Error(
			"Mail configuration 'username' must not contain line breaks.",
		);
	const password = requireString(
		record.password,
		"password",
		MAX_PASSWORD_BYTES,
	);
	const from = normalizeMailbox(record.from, "from");
	if (
		!Array.isArray(record.to) ||
		record.to.length === 0 ||
		record.to.length > MAX_RECIPIENTS
	) {
		throw new Error(
			`Mail configuration 'to' must contain 1 through ${MAX_RECIPIENTS} addresses.`,
		);
	}
	const to = record.to.map((recipient, index) =>
		normalizeMailbox(recipient, `to[${index}]`),
	);
	const uniqueRecipients = new Set(
		to.map((recipient) => recipient.toLowerCase()),
	);
	if (uniqueRecipients.size !== to.length)
		throw new Error("Mail configuration 'to' contains duplicate addresses.");

	return { host, port: record.port as number, username, password, from, to };
}

export async function loadMailConfig(path: string): Promise<MailConfig> {
	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		fileStat = await stat(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot access mail configuration ${path}: ${message}`);
	}
	if (!fileStat.isFile())
		throw new Error(`Mail configuration is not a regular file: ${path}`);
	if (fileStat.size > MAX_CONFIG_BYTES) {
		throw new Error(
			`Mail configuration exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`,
		);
	}
	if (process.platform !== "win32") {
		if ((fileStat.mode & 0o077) !== 0) {
			throw new Error(
				`Mail configuration permissions are too broad; run: chmod 600 ${path}`,
			);
		}
		const uid = process.getuid?.();
		if (uid !== undefined && fileStat.uid !== uid) {
			throw new Error(
				`Mail configuration must be owned by the current user: ${path}`,
			);
		}
	}

	const content = await readFile(path, "utf8");
	if (byteLength(content) > MAX_CONFIG_BYTES) {
		throw new Error(
			`Mail configuration exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch {
		throw new Error("Mail configuration is not valid JSON.");
	}
	return validateConfig(parsed);
}

export function validateMailContent(subject: string, body: string): void {
	if (subject.length === 0) throw new Error("Mail subject must not be empty.");
	if (/[\r\n\0]/.test(subject))
		throw new Error("Mail subject must not contain line breaks or NUL.");
	if (byteLength(subject) > MAX_SUBJECT_BYTES) {
		throw new Error(`Mail subject exceeds ${MAX_SUBJECT_BYTES} UTF-8 bytes.`);
	}
	if (body.length === 0) throw new Error("Mail body must not be empty.");
	if (body.includes("\0")) throw new Error("Mail body must not contain NUL.");
	if (byteLength(body) > MAX_BODY_BYTES)
		throw new Error(`Mail body exceeds ${MAX_BODY_BYTES} UTF-8 bytes.`);
}

function encodedWords(value: string): string[] {
	const chunks: string[] = [];
	let current = "";
	let currentBytes = 0;
	for (const character of value) {
		const characterBytes = byteLength(character);
		if (current && currentBytes + characterBytes > HEADER_ENCODED_WORD_BYTES) {
			chunks.push(current);
			current = "";
			currentBytes = 0;
		}
		current += character;
		currentBytes += characterBytes;
	}
	if (current) chunks.push(current);
	return chunks.map(
		(chunk) => `=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`,
	);
}

function encodeSubject(subject: string): string {
	return encodedWords(subject).join("\r\n ");
}

function foldAddressHeader(name: string, addresses: string[]): string {
	return `${name}: ${addresses.join(",\r\n ")}`;
}

function safeHostname(value: string): string {
	const normalized = value
		.toLowerCase()
		.split(".")
		.map((label) =>
			label
				.replace(/[^a-z0-9-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 63)
				.replace(/-+$/g, ""),
		)
		.filter(Boolean)
		.join(".")
		.slice(0, 253)
		.replace(/\.$/, "");
	return normalized && DNS_NAME_PATTERN.test(normalized)
		? normalized
		: "unknown-host";
}

function wrapBase64(value: string): string {
	const encoded = Buffer.from(value, "utf8").toString("base64");
	const lines: string[] = [];
	for (let offset = 0; offset < encoded.length; offset += 76) {
		lines.push(encoded.slice(offset, offset + 76));
	}
	return lines.join("\r\n");
}

export function buildMailMessage(
	config: Pick<MailConfig, "from" | "to">,
	subject: string,
	body: string,
	hostname = systemHostname(),
	now = new Date(),
	id: string = randomUUID(),
): MailMessage {
	validateMailContent(subject, body);
	const normalizedHostname = safeHostname(hostname);
	const senderDomain = config.from.slice(config.from.lastIndexOf("@") + 1);
	const messageId = `<${id}@${senderDomain}>`;
	const headers = [
		`From: "Pi on ${normalizedHostname}" <${config.from}>`,
		foldAddressHeader("To", config.to),
		`Subject: ${encodeSubject(subject)}`,
		`Date: ${now.toUTCString()}`,
		`Message-ID: ${messageId}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
		"Auto-Submitted: auto-generated",
		`X-Pi-Hostname: ${normalizedHostname}`,
	];
	return {
		data: `${headers.join("\r\n")}\r\n\r\n${wrapBase64(body)}\r\n`,
		messageId,
		hostname: normalizedHostname,
	};
}

export class SmtpLineBuffer {
	private pending = Buffer.alloc(0);
	private lines: Buffer[] = [];
	private queuedBytes = 0;

	feed(chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.pending = Buffer.concat([this.pending, chunk]);
		if (this.pending.length + this.queuedBytes > MAX_SMTP_BUFFER_BYTES) {
			throw new Error("SMTP server response exceeded the buffer limit.");
		}
		while (true) {
			const end = this.pending.indexOf("\r\n");
			if (end < 0) {
				if (this.pending.length > MAX_SMTP_LINE_BYTES)
					throw new Error("SMTP server response line is too long.");
				return;
			}
			if (end > MAX_SMTP_LINE_BYTES)
				throw new Error("SMTP server response line is too long.");
			const line = this.pending.subarray(0, end);
			this.pending = this.pending.subarray(end + 2);
			this.lines.push(line);
			this.queuedBytes += line.length;
		}
	}

	shift(): string | undefined {
		const line = this.lines.shift();
		if (!line) return undefined;
		this.queuedBytes -= line.length;
		return line.toString("utf8");
	}
}

class SocketSmtpTransport implements SmtpTransport {
	private socket: TLSSocket;
	private lineBuffer = new SmtpLineBuffer();
	private terminalError: Error | undefined;
	private pendingRead: (() => void) | undefined;

	constructor(socket: TLSSocket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => {
			try {
				this.lineBuffer.feed(chunk);
				this.pendingRead?.();
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.on("error", (error) => this.fail(error));
		socket.on("close", () => this.fail(new Error("SMTP connection closed.")));
	}

	async readLine(signal?: AbortSignal): Promise<string> {
		while (true) {
			const line = this.lineBuffer.shift();
			if (line !== undefined) return line;
			if (this.terminalError) throw this.terminalError;
			if (signal?.aborted) throw abortError(signal);
			await new Promise<void>((resolve, reject) => {
				const onAbort = (): void => {
					cleanup();
					this.socket.destroy();
					reject(abortError(signal));
				};
				const cleanup = (): void => {
					if (this.pendingRead === wake) this.pendingRead = undefined;
					signal?.removeEventListener("abort", onAbort);
				};
				const wake = (): void => {
					cleanup();
					resolve();
				};
				this.pendingRead = wake;
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
	}

	async write(data: string, signal?: AbortSignal): Promise<void> {
		if (this.terminalError) throw this.terminalError;
		if (signal?.aborted) throw abortError(signal);
		await new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				cleanup();
				this.socket.destroy();
				reject(abortError(signal));
			};
			const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.socket.write(data, "utf8", (error?: Error | null) => {
				cleanup();
				if (error) reject(error);
				else resolve();
			});
		});
	}

	close(): void {
		this.socket.destroy();
	}

	private fail(error: Error): void {
		if (!this.terminalError) this.terminalError = error;
		this.pendingRead?.();
	}
}

function abortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	const error = new Error("Mail delivery cancelled.");
	error.name = "AbortError";
	return error;
}

async function connectTransport(
	config: MailConfig,
	signal?: AbortSignal,
): Promise<SmtpTransport> {
	if (signal?.aborted) throw abortError(signal);
	const options: ConnectionOptions = {
		host: config.host,
		port: config.port,
		servername: config.host,
		rejectUnauthorized: true,
		minVersion: "TLSv1.2",
	};
	return new Promise<SmtpTransport>((resolve, reject) => {
		const socket = connectTls(options);
		const onAbort = (): void => {
			cleanup();
			socket.destroy();
			reject(abortError(signal));
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const cleanup = (): void => {
			signal?.removeEventListener("abort", onAbort);
			socket.removeListener("error", onError);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		socket.once("error", onError);
		socket.once("secureConnect", () => {
			cleanup();
			resolve(new SocketSmtpTransport(socket));
		});
	});
}

export async function readSmtpResponse(
	transport: SmtpTransport,
	signal?: AbortSignal,
): Promise<SmtpResponse> {
	const first = await transport.readLine(signal);
	const match = /^(\d{3})([ -])(.*)$/.exec(first);
	if (!match) throw new Error("SMTP server returned a malformed response.");
	const code = Number(match[1]);
	const lines = [match[3] ?? ""];
	let separator = match[2];
	let responseBytes = byteLength(first);
	while (separator === "-") {
		const line = await transport.readLine(signal);
		responseBytes += byteLength(line);
		if (responseBytes > MAX_SMTP_BUFFER_BYTES)
			throw new Error("SMTP server response exceeded the buffer limit.");
		const continuation = /^(\d{3})([ -])(.*)$/.exec(line);
		if (!continuation || Number(continuation[1]) !== code) {
			throw new Error(
				"SMTP server returned an inconsistent multiline response.",
			);
		}
		lines.push(continuation[3] ?? "");
		separator = continuation[2];
	}
	return { code, lines };
}

function responseSummary(response: SmtpResponse): string {
	const summary = response.lines
		.join(" ")
		.replace(/[\r\n\0]+/g, " ")
		.trim();
	return summary.length <= 300 ? summary : `${summary.slice(0, 297)}...`;
}

function requireResponse(
	response: SmtpResponse,
	expected: number[],
	operation: string,
	includeDiagnostic = true,
): void {
	if (!expected.includes(response.code)) {
		const summary = includeDiagnostic ? responseSummary(response) : "";
		throw new Error(
			`${operation} failed with SMTP ${response.code}${summary ? `: ${summary}` : "."}`,
		);
	}
}

async function command(
	transport: SmtpTransport,
	value: string,
	expected: number[],
	operation: string,
	signal?: AbortSignal,
	includeDiagnostic = true,
): Promise<SmtpResponse> {
	await transport.write(`${value}\r\n`, signal);
	const response = await readSmtpResponse(transport, signal);
	requireResponse(response, expected, operation, includeDiagnostic);
	return response;
}

function supportsPlainAuth(response: SmtpResponse): boolean {
	for (const line of response.lines) {
		const match = /^AUTH(?:=|\s+)(.*)$/i.exec(line.trim());
		if (
			match?.[1]
				?.split(/\s+/)
				.some((mechanism) => mechanism.toUpperCase() === "PLAIN")
		)
			return true;
	}
	return false;
}

function dotStuff(message: string): string {
	const canonical = message
		.replace(/\r?\n/g, "\r\n")
		.replace(/\r(?!\n)/g, "\r\n");
	const terminated = canonical.endsWith("\r\n")
		? canonical
		: `${canonical}\r\n`;
	return terminated.replace(/(^|\r\n)\./g, "$1..");
}

export async function runSmtpTransaction(
	transport: SmtpTransport,
	config: MailConfig,
	message: string,
	heloHostname: string,
	signal?: AbortSignal,
): Promise<void> {
	const greeting = await readSmtpResponse(transport, signal);
	requireResponse(greeting, [220], "SMTP greeting");
	const ehlo = await command(
		transport,
		`EHLO ${safeHostname(heloHostname)}`,
		[250],
		"SMTP EHLO",
		signal,
	);
	if (!supportsPlainAuth(ehlo))
		throw new Error(
			"SMTP server does not advertise AUTH PLAIN over the verified TLS connection.",
		);

	const auth = Buffer.from(
		`\0${config.username}\0${config.password}`,
		"utf8",
	).toString("base64");
	await command(
		transport,
		`AUTH PLAIN ${auth}`,
		[235],
		"SMTP authentication",
		signal,
		false,
	);
	await command(
		transport,
		`MAIL FROM:<${config.from}>`,
		[250],
		"SMTP sender",
		signal,
	);
	for (const recipient of config.to) {
		await command(
			transport,
			`RCPT TO:<${recipient}>`,
			[250, 251],
			`SMTP recipient ${recipient}`,
			signal,
		);
	}
	await command(transport, "DATA", [354], "SMTP DATA", signal);

	try {
		await transport.write(`${dotStuff(message)}.\r\n`, signal);
		const accepted = await readSmtpResponse(transport, signal);
		requireResponse(accepted, [250], "SMTP message acceptance");
	} catch (error) {
		if (
			error instanceof Error &&
			/^SMTP message acceptance failed/.test(error.message)
		)
			throw error;
		const messageText = error instanceof Error ? error.message : String(error);
		throw new DeliveryOutcomeUnknownError(
			`Mail delivery outcome is unknown because the connection ended after DATA was submitted: ${messageText}`,
		);
	}

	try {
		await transport.write("QUIT\r\n", signal);
	} catch {
		// The server already accepted the message; QUIT failure does not change delivery status.
	}
}

export async function sendMail(
	config: MailConfig,
	message: MailMessage,
	signal?: AbortSignal,
): Promise<void> {
	const timeoutController = new AbortController();
	const timeout = setTimeout(
		() =>
			timeoutController.abort(
				new Error(
					`SMTP delivery timed out after ${SMTP_TIMEOUT_MS / 1000} seconds.`,
				),
			),
		SMTP_TIMEOUT_MS,
	);
	const combinedSignal = signal
		? AbortSignal.any([signal, timeoutController.signal])
		: timeoutController.signal;
	let transport: SmtpTransport | undefined;
	try {
		transport = await connectTransport(config, combinedSignal);
		await runSmtpTransaction(
			transport,
			config,
			message.data,
			message.hostname,
			combinedSignal,
		);
	} finally {
		clearTimeout(timeout);
		transport?.close();
	}
}
