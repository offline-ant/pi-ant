import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
	fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
	AgentSession, ModelRuntime, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runDocumentFlowReview } from "./document-flow-review-runner.ts";

const next = (afterUnit: number) => fauxAssistantMessage(
	fauxToolCall("next_reading_unit", { afterUnit, friction: [] }), { stopReason: "toolUse" },
);

async function fixture(t: TestContext) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-flow-cancel-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(path.join(cwd, "document.md"), "First sentence. Second sentence. Third sentence.\n");
	const provider = fauxProvider({ provider: "flow-review-test", tokensPerSecond: 100_000 });
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsPath: null,
		modelsStorePath: path.join(cwd, "models-store.json"), refreshOnCreate: false,
	});
	runtime.registerNativeProvider(provider.provider);
	t.mock.method(ModelRuntime, "create", async () => runtime);
	const disposed: AgentSession[] = [];
	const dispose = AgentSession.prototype.dispose;
	t.mock.method(AgentSession.prototype, "dispose", function (this: AgentSession) {
		assert.equal(this.isStreaming, false, "nested work must finish before disposal");
		disposed.push(this);
		dispose.call(this);
	});
	const controller = new AbortController();
	const reason = new Error("Document flow review cancelled by Escape");
	const pi = { getThinkingLevel: () => "off" } as ExtensionAPI;
	const ctx = {
		cwd, model: provider.getModel(), modelRegistry: { getRegisteredProviderConfig: () => undefined },
	} as unknown as ExtensionContext;
	const run = (onProgress?: (text: string) => void) => runDocumentFlowReview(
		pi, ctx, { file: "document.md" }, onProgress, controller.signal,
	);
	return { cwd, provider, controller, reason, run, disposed };
}

for (const [phase, prefix] of [
	["initial response", []],
	["reading", [next(0)]],
	["continuation", [fauxAssistantMessage("Stopped early.")]],
	["final response", [next(0), next(1)]],
	["final-report follow-up", [next(0), next(1), fauxAssistantMessage("")]],
] as const) {
	test(`Escape during ${phase} aborts the reader without restarting or saving a report`, { timeout: 10_000 }, async (t) => {
		const f = await fixture(t);
		let childAborted = false;
		const hold: FauxResponseStep = async (_context, options) => {
			assert.ok(options?.signal);
			await new Promise<void>((resolve) => {
				options.signal!.addEventListener("abort", () => { childAborted = true; resolve(); }, { once: true });
				setImmediate(() => f.controller.abort(f.reason));
			});
			return fauxAssistantMessage("Incomplete review must not be published.");
		};
		f.provider.setResponses([...prefix, hold]);
		await assert.rejects(f.run(), (error) => error === f.reason);
		assert.equal(childAborted, true);
		assert.equal(f.provider.state.callCount, prefix.length + 1, "no continuation after cancellation");
		assert.equal(f.disposed.length, 1);
		const root = path.join(f.cwd, "scratch/document-flow-review");
		const directories = await readdir(root);
		assert.equal(directories.length, 1);
		const artifacts = path.join(root, directories[0]!);
		const files = await readdir(artifacts);
		assert.ok(!files.includes("review.md"));
		assert.ok(!files.includes("metadata.json"));
		assert.match(await readFile(path.join(artifacts, "error.txt"), "utf8"), /cancelled by Escape/);
	});
}

test("an already cancelled review does not read the file or create artifacts", async (t) => {
	const f = await fixture(t);
	await rm(path.join(f.cwd, "document.md"));
	f.controller.abort(f.reason);
	await assert.rejects(f.run(), (error) => error === f.reason);
	assert.equal(f.provider.state.callCount, 0);
	assert.equal(f.disposed.length, 0);
	assert.ok(!(await readdir(f.cwd)).includes("scratch"));
});

test("cancellation during setup prevents reader creation", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.run(() => f.controller.abort(f.reason)), (error) => error === f.reason);
	assert.equal(f.provider.state.callCount, 0);
	assert.equal(f.disposed.length, 0);
});

test("cancellation during prompt preflight is applied when the agent starts", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t);
	const prompt = AgentSession.prototype.prompt;
	t.mock.method(AgentSession.prototype, "prompt", function (this: AgentSession, ...args: Parameters<typeof prompt>) {
		f.controller.abort(f.reason);
		return prompt.apply(this, args);
	});
	f.provider.setResponses([fauxAssistantMessage("Cancelled output.")]);
	await assert.rejects(f.run(), (error) => error === f.reason);
	assert.ok(f.provider.state.callCount <= 1);
	assert.equal(f.disposed.length, 1);
});

test("uncancelled early stops still continue and publish the completed review", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t);
	f.provider.setResponses([
		fauxAssistantMessage("Stopped early."), next(0), next(1),
		fauxAssistantMessage(""), fauxAssistantMessage("Complete sequential review."),
	]);
	const result = await f.run();
	assert.equal(result.report, "Complete sequential review.");
	assert.equal(await readFile(result.reportPath, "utf8"), `${result.report}\n`);
	assert.equal(result.unitCount, 1);
	assert.equal(f.provider.state.callCount, 5);
	assert.equal(f.disposed.length, 1);
});
