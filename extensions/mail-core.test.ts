import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildMailMessage,
	DeliveryOutcomeUnknownError,
	loadMailConfig,
	type MailConfig,
	readSmtpResponse,
	runSmtpTransaction,
	SmtpLineBuffer,
	type SmtpTransport,
	validateMailContent,
} from "./mail-core.ts";

const VALID_CONFIG: MailConfig = {
	host: "mail.roelof.solar",
	port: 465,
	username: "pi-sender@roelof.solar",
	password: "test-only-secret",
	from: "pi-sender@roelof.solar",
	to: ["self.pi@roelof.solar"],
};

class ScriptedTransport implements SmtpTransport {
	lines: string[];
	writes: string[] = [];
	closed = false;
	failWritesWithPrefix: string | undefined;

	constructor(lines: string[]) {
		this.lines = [...lines];
	}

	async readLine(): Promise<string> {
		const line = this.lines.shift();
		if (line === undefined) throw new Error("scripted connection closed");
		return line;
	}

	async write(data: string): Promise<void> {
		this.writes.push(data);
		if (
			this.failWritesWithPrefix &&
			data.startsWith(this.failWritesWithPrefix)
		) {
			throw new Error("scripted write failure");
		}
	}

	close(): void {
		this.closed = true;
	}
}

async function withConfigFile(
	value: unknown,
	mode = 0o600,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-mail-test-"));
	const path = join(directory, "mail.json");
	await writeFile(path, JSON.stringify(value), { mode: 0o600 });
	await chmod(path, mode);
	return {
		path,
		cleanup: () => rm(directory, { recursive: true, force: true }),
	};
}

function successfulReplies(recipientCount = 1): string[] {
	return [
		"220 mail.roelof.solar ESMTP ready",
		"250-mail.roelof.solar",
		"250-AUTH PLAIN LOGIN",
		"250 SIZE 1048576",
		"235 2.7.0 authentication successful",
		"250 2.1.0 sender accepted",
		...Array.from(
			{ length: recipientCount },
			() => "250 2.1.5 recipient accepted",
		),
		"354 send message",
		"250 2.0.0 queued",
	];
}

test("loadMailConfig accepts a strict owner-only configuration", async () => {
	const fixture = await withConfigFile(VALID_CONFIG);
	try {
		assert.deepEqual(await loadMailConfig(fixture.path), VALID_CONFIG);
	} finally {
		await fixture.cleanup();
	}
});

test("loadMailConfig rejects unknown keys and broad permissions", async () => {
	const unknown = await withConfigFile({ ...VALID_CONFIG, insecure: true });
	try {
		await assert.rejects(
			loadMailConfig(unknown.path),
			/Unknown mail configuration key 'insecure'/,
		);
	} finally {
		await unknown.cleanup();
	}

	if (process.platform !== "win32") {
		const broad = await withConfigFile(VALID_CONFIG, 0o644);
		try {
			await assert.rejects(loadMailConfig(broad.path), /chmod 600/);
		} finally {
			await broad.cleanup();
		}
	}
});

test("loadMailConfig never exposes malformed JSON containing a password", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-mail-test-"));
	const path = join(directory, "mail.json");
	const secret = "malformed-json-secret-must-not-leak";
	await writeFile(path, `{"password":"${secret}",BROKEN`, { mode: 0o600 });
	try {
		await assert.rejects(loadMailConfig(path), (error: unknown) => {
			assert(error instanceof Error);
			assert.equal(error.message, "Mail configuration is not valid JSON.");
			assert.equal(error.message.includes(secret), false);
			return true;
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("loadMailConfig validates addresses and never reveals a rejected password", async () => {
	const password = "do-not-print-this-secret";
	const fixture = await withConfigFile({
		...VALID_CONFIG,
		password,
		to: ["bad address"],
	});
	try {
		await assert.rejects(loadMailConfig(fixture.path), (error: unknown) => {
			assert(error instanceof Error);
			assert.match(error.message, /plain ASCII email address/);
			assert.equal(error.message.includes(password), false);
			return true;
		});
	} finally {
		await fixture.cleanup();
	}
});

test("validateMailContent rejects header injection, NUL, and byte-limit overflow", () => {
	assert.throws(
		() => validateMailContent("hello\nBcc: x@example.com", "body"),
		/line breaks/,
	);
	assert.throws(() => validateMailContent("hello", "body\0suffix"), /NUL/);
	assert.throws(
		() => validateMailContent("x".repeat(257), "body"),
		/256 UTF-8 bytes/,
	);
	assert.throws(
		() => validateMailContent("subject", "é".repeat(32_769)),
		/65536 UTF-8 bytes/,
	);
});

test("buildMailMessage produces CRLF MIME mail with encoded Unicode and traceable host", () => {
	const message = buildMailMessage(
		VALID_CONFIG,
		"Status voor café",
		"First line\nTweede regel: ✓",
		"Build_HOST.example",
		new Date("2026-06-06T12:00:00Z"),
		"fixed-id",
	);
	assert.equal(message.messageId, "<fixed-id@roelof.solar>");
	assert.equal(message.hostname, "build-host.example");
	assert.equal(
		buildMailMessage(
			VALID_CONFIG,
			"subject",
			"body",
			"invalid_",
			new Date(),
			"id",
		).hostname,
		"invalid",
	);
	assert.equal(/(?<!\r)\n/.test(message.data), false);
	assert.match(message.data, /Subject: =\?UTF-8\?B\?/);
	assert.match(message.data, /X-Pi-Hostname: build-host\.example/);
	assert.match(message.data, /Content-Transfer-Encoding: base64/);
	const encodedBody =
		message.data.split("\r\n\r\n", 2)[1]?.replace(/\r\n/g, "") ?? "";
	assert.equal(
		Buffer.from(encodedBody, "base64").toString("utf8"),
		"First line\nTweede regel: ✓",
	);
	for (const line of message.data.split("\r\n")) assert(line.length <= 998);
});

test("SmtpLineBuffer handles fragmented and coalesced CRLF lines", () => {
	const buffer = new SmtpLineBuffer();
	buffer.feed(Buffer.from("250-first\r"));
	assert.equal(buffer.shift(), undefined);
	buffer.feed(Buffer.from("\n250 second\r\n220 next\r\n"));
	assert.equal(buffer.shift(), "250-first");
	assert.equal(buffer.shift(), "250 second");
	assert.equal(buffer.shift(), "220 next");
	assert.equal(buffer.shift(), undefined);
});

test("readSmtpResponse parses multiline responses and rejects inconsistent codes", async () => {
	const valid = new ScriptedTransport([
		"250-first",
		"250-AUTH PLAIN",
		"250 SIZE 100",
	]);
	assert.deepEqual(await readSmtpResponse(valid), {
		code: 250,
		lines: ["first", "AUTH PLAIN", "SIZE 100"],
	});
	const invalid = new ScriptedTransport(["250-first", "550 wrong"]);
	await assert.rejects(
		readSmtpResponse(invalid),
		/inconsistent multiline response/,
	);
});

test("runSmtpTransaction authenticates and submits only configured recipients", async () => {
	const transport = new ScriptedTransport(successfulReplies());
	await runSmtpTransaction(
		transport,
		VALID_CONFIG,
		"Header: value\r\n\r\n.body\r\n",
		"voidpc",
	);
	assert.equal(transport.writes[0], "EHLO voidpc\r\n");
	assert.equal(transport.writes[2], "MAIL FROM:<pi-sender@roelof.solar>\r\n");
	assert.equal(transport.writes[3], "RCPT TO:<self.pi@roelof.solar>\r\n");
	assert.equal(transport.writes[4], "DATA\r\n");
	const authCommand = transport.writes[1] ?? "";
	assert.match(authCommand, /^AUTH PLAIN /);
	const authPayload = authCommand.trim().slice("AUTH PLAIN ".length);
	assert.equal(
		Buffer.from(authPayload, "base64").toString("utf8"),
		`\0${VALID_CONFIG.username}\0${VALID_CONFIG.password}`,
	);
	assert.match(transport.writes[5] ?? "", /\r\n\.\.body\r\n\.\r\n$/);
	assert.equal(transport.writes[6], "QUIT\r\n");
});

test("runSmtpTransaction does not expose credentials echoed by an authentication failure", async () => {
	const authPayload = Buffer.from(
		`\0${VALID_CONFIG.username}\0${VALID_CONFIG.password}`,
		"utf8",
	).toString("base64");
	const transport = new ScriptedTransport([
		"220 ready",
		"250-mail.example",
		"250 AUTH PLAIN",
		`535 rejected ${authPayload} ${VALID_CONFIG.password}`,
	]);
	await assert.rejects(
		runSmtpTransaction(
			transport,
			VALID_CONFIG,
			"Header: value\r\n\r\nbody\r\n",
			"voidpc",
		),
		(error: unknown) => {
			assert(error instanceof Error);
			assert.match(error.message, /SMTP authentication failed with SMTP 535/);
			assert.equal(error.message.includes(authPayload), false);
			assert.equal(error.message.includes(VALID_CONFIG.password), false);
			return true;
		},
	);
});

test("runSmtpTransaction refuses servers without AUTH PLAIN", async () => {
	const transport = new ScriptedTransport([
		"220 ready",
		"250-mail.example",
		"250 AUTH LOGIN",
	]);
	await assert.rejects(
		runSmtpTransaction(
			transport,
			VALID_CONFIG,
			"Header: value\r\n\r\nbody\r\n",
			"voidpc",
		),
		/AUTH PLAIN/,
	);
	assert.equal(
		transport.writes.some((write) => write.startsWith("AUTH ")),
		false,
	);
});

test("runSmtpTransaction does not send DATA after recipient rejection", async () => {
	const transport = new ScriptedTransport([
		"220 ready",
		"250-mail.example",
		"250 AUTH PLAIN",
		"235 authenticated",
		"250 sender accepted",
		"550 recipient rejected",
	]);
	await assert.rejects(
		runSmtpTransaction(
			transport,
			VALID_CONFIG,
			"Header: value\r\n\r\nbody\r\n",
			"voidpc",
		),
		/SMTP recipient self\.pi@roelof\.solar failed with SMTP 550/,
	);
	assert.equal(transport.writes.includes("DATA\r\n"), false);
});

test("runSmtpTransaction reports an unknown outcome after DATA connection loss", async () => {
	const replies = successfulReplies();
	replies.pop();
	const transport = new ScriptedTransport(replies);
	await assert.rejects(
		runSmtpTransaction(
			transport,
			VALID_CONFIG,
			"Header: value\r\n\r\nbody\r\n",
			"voidpc",
		),
		(error: unknown) => {
			assert(error instanceof DeliveryOutcomeUnknownError);
			assert.match(error.message, /outcome is unknown/);
			return true;
		},
	);
});

test("runSmtpTransaction treats QUIT failure as success after acceptance", async () => {
	const transport = new ScriptedTransport(successfulReplies());
	transport.failWritesWithPrefix = "QUIT";
	await runSmtpTransaction(
		transport,
		VALID_CONFIG,
		"Header: value\r\n\r\nbody\r\n",
		"voidpc",
	);
});
