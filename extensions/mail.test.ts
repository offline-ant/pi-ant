import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerMail from "./mail.ts";

test("mail registers only mail_user with fixed-recipient parameters", () => {
	const names: string[] = [];
	registerMail({
		registerTool(tool) {
			names.push(tool.name);
			assert.equal(tool.label, "Mail User");
			const schema = tool.parameters;
			assert("properties" in schema);
			assert(typeof schema.properties === "object" && schema.properties !== null);
			assert.deepEqual(Object.keys(schema.properties), ["subject", "body"]);
			assert("required" in schema);
			assert.deepEqual(schema.required, ["subject", "body"]);
			assert.match(tool.description, /Recipients and sender are fixed by configuration/);
			assert.match(tool.description, /confirms every send/);
			assert(tool.promptGuidelines?.every((line) => line.includes("mail_user")));
		},
	} as ExtensionAPI);
	assert.deepEqual(names, ["mail_user"]);
});
