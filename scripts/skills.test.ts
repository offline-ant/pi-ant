import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, formatSkillsForPrompt, SettingsManager } from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("package discovers Himalaya mail and preserves Herdr skill without extensions or inference", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-ant-skills-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: join(directory, "agent"),
			settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const { skills, diagnostics } = loader.getSkills();
		assert.deepEqual(diagnostics, []);
		for (const name of ["herdr", "himalaya-mail"]) {
			const matches = skills.filter((skill) => skill.name === name);
			assert.equal(matches.length, 1, `${name} must be discovered once`);
			assert.equal(matches[0].filePath, join(packageRoot, "skills", name, "SKILL.md"));
			assert.equal(matches[0].disableModelInvocation, false);
			assert(matches[0].description.length > 0);
		}
		assert.match(formatSkillsForPrompt(skills), /<name>himalaya-mail<\/name>/);
		assert.equal(loader.getExtensions().extensions.length, 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
