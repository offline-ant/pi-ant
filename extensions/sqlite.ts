import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Static } from "typebox";
import { Type } from "typebox";

const DATABASE_FILE = "AGENTS.db";
const METADATA_TABLE = "tables";

const SQLITE_PARAMS = Type.Object({
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Arguments to pass directly to sqlite3 after the AGENTS.db path, e.g. ['-header', '-column'].",
		}),
	),
	stdin: Type.Optional(
		Type.String({
			description: "SQL or dot-commands to send to sqlite3 stdin. Use this for queries and schema changes.",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({ description: "Timeout in seconds before sqlite3 is killed. Defaults to 30." }),
	),
});

type SqliteParams = Static<typeof SQLITE_PARAMS>;

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

interface SqliteToolDetails extends CommandResult {
	args: string[];
	database: string;
	metadataWarning?: string;
	truncated: boolean;
}

function databasePath(cwd: string): string {
	return path.join(cwd, DATABASE_FILE);
}

async function databaseExists(cwd: string): Promise<boolean> {
	try {
		await fsAccess(databasePath(cwd), constants.R_OK | constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function runSqlite(cwd: string, args: string[], stdin: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn("sqlite3", [databasePath(cwd), ...args], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let killed = false;

		const timeout = setTimeout(() => {
			killed = true;
			child.kill("SIGTERM");
		}, timeoutMs);

		const abort = () => {
			killed = true;
			child.kill("SIGTERM");
		};

		if (signal) {
			if (signal.aborted) abort();
			signal.addEventListener("abort", abort, { once: true });
		}

		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			resolve({ stdout, stderr: stderr ? `${stderr}\n${error.message}` : error.message, code: 1, killed });
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			resolve({ stdout, stderr, code: code ?? 1, killed });
		});

		child.stdin.end(stdin);
	});
}

function formatCommandOutput(result: CommandResult): string {
	let output = result.stdout;
	if (result.stderr) {
		output += `${output ? "\n" : ""}[stderr]\n${result.stderr}`;
	}
	if (!output) output = "(no output)";
	if (result.killed) output += `${output.endsWith("\n") ? "" : "\n"}[sqlite3 killed]`;
	return output;
}

function truncateOutput(output: string): { text: string; truncated: boolean } {
	const truncation = truncateTail(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	let text = truncation.content;
	if (truncation.truncated) {
		text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
	}
	return { text, truncated: truncation.truncated };
}

async function queryList(cwd: string, sql: string): Promise<string[]> {
	const result = await runSqlite(cwd, ["-batch", "-noheader", "-separator", "\t"], sql);
	if (result.code !== 0) {
		throw new Error(formatCommandOutput(result));
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

async function setupMetadataTable(cwd: string): Promise<void> {
	const result = await runSqlite(
		cwd,
		["-batch"],
		`CREATE TABLE IF NOT EXISTS ${METADATA_TABLE} (
	name TEXT PRIMARY KEY,
	description TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO ${METADATA_TABLE} (name, description)
VALUES ('${METADATA_TABLE}', 'Stores descriptions for the tables and views in this project database. Every table/view should have one row here.')
ON CONFLICT(name) DO NOTHING;
`,
	);
	if (result.code !== 0) {
		throw new Error(formatCommandOutput(result));
	}
}

async function getSchemaObjectNames(cwd: string): Promise<string[]> {
	return queryList(
		cwd,
		"SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name;",
	);
}

async function getTableDescriptions(cwd: string): Promise<Map<string, string>> {
	const metadataExists = await queryList(
		cwd,
		`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = '${METADATA_TABLE}';`,
	);
	if (metadataExists.length === 0) return new Map();

	const rows = await queryList(
		cwd,
		`SELECT name || char(9) || description FROM ${METADATA_TABLE} WHERE trim(description) <> '' ORDER BY name;`,
	);
	return new Map(
		rows
			.map((line) => {
				const separatorIndex = line.indexOf("\t");
				if (separatorIndex === -1) return undefined;
				return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)] as const;
			})
			.filter((entry): entry is readonly [string, string] => entry !== undefined),
	);
}

async function getMetadataWarning(cwd: string): Promise<string | undefined> {
	const objectNames = await getSchemaObjectNames(cwd);
	if (objectNames.length === 0) return undefined;

	const descriptions = await getTableDescriptions(cwd);
	const missingObjects = objectNames.filter((objectName) => !descriptions.has(objectName));
	if (missingObjects.length === 0) return undefined;

	return `Warning: missing ${METADATA_TABLE}.description entries for table/view(s): ${missingObjects.join(", ")}. Add rows to ${METADATA_TABLE} so each table/view is described.`;
}

async function buildDatabaseSummary(cwd: string): Promise<string> {
	const schema = await runSqlite(cwd, ["-batch"], ".schema\n");
	if (schema.code !== 0) {
		throw new Error(formatCommandOutput(schema));
	}

	const objects = await queryList(
		cwd,
		"SELECT type || char(9) || name FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name;",
	);

	const tables = objects
		.map((line) => {
			const [type, name] = line.split("\t");
			return type && name ? { type, name } : undefined;
		})
		.filter((entry): entry is { type: string; name: string } => entry !== undefined);

	const descriptions = await getTableDescriptions(cwd);
	const metadataWarning = await getMetadataWarning(cwd);
	const sections = [`SQLite database: ${databasePath(cwd)}`];
	sections.push("## Layout (.schema)");
	sections.push(schema.stdout.trim() || "(empty database)");

	sections.push("## Tables/views: descriptions and row counts");
	if (tables.length === 0) {
		sections.push("(no user tables or views)");
		return sections.join("\n\n");
	}

	for (const table of tables) {
		const quotedName = quoteIdentifier(table.name);
		const countInfo = await runSqlite(cwd, ["-batch", "-noheader"], `SELECT COUNT(*) FROM ${quotedName};\n`);
		const count = countInfo.code === 0 ? countInfo.stdout.trim() : `error: ${formatCommandOutput(countInfo).trim()}`;
		const description = descriptions.get(table.name) ?? "(missing description in tables metadata)";

		sections.push(`### ${table.type} ${table.name}\nDescription: ${description}\nRows: ${count}`);
	}

	if (metadataWarning) {
		sections.push(metadataWarning);
	}

	return sections.join("\n\n");
}

function syncSqliteToolVisibility(pi: ExtensionAPI, exists: boolean): void {
	const activeTools = pi.getActiveTools();
	const hasTool = activeTools.includes("sqlite");
	if (exists && !hasTool) {
		pi.setActiveTools([...activeTools, "sqlite"]);
		return;
	}
	if (!exists && hasTool) {
		pi.setActiveTools(activeTools.filter((tool) => tool !== "sqlite"));
	}
}

async function insertDatabaseSummary(pi: ExtensionAPI, cwd: string): Promise<void> {
	const summary = await buildDatabaseSummary(cwd);
	pi.sendMessage(
		{
			customType: "sqlite-summary",
			content: summary,
			display: true,
			details: { database: databasePath(cwd) },
		},
		{ triggerTurn: false },
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "sqlite",
		label: "SQLite",
		description: `Run sqlite3 against ${DATABASE_FILE}, forwarding args and stdin directly. Schema changes must maintain one concise ${METADATA_TABLE} description row per table/view. The database is editable workflow state, not append-only history. Returns stdout/stderr plus metadata warnings; missing databases and failed/killed commands throw. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: SQLITE_PARAMS,
		async execute(_toolCallId, params: SqliteParams, signal, _onUpdate, ctx) {
			if (!(await databaseExists(ctx.cwd))) {
				throw new Error(`${DATABASE_FILE} does not exist in ${ctx.cwd}. Run /sqlite-init first.`);
			}

			const args = params.args ?? [];
			const result = await runSqlite(ctx.cwd, args, params.stdin ?? "", signal, (params.timeoutSeconds ?? 30) * 1000);
			const metadataWarning = await getMetadataWarning(ctx.cwd);
			const formatted = formatCommandOutput(result) + (metadataWarning ? `\n\n${metadataWarning}` : "");
			const output = truncateOutput(formatted);
			const details: SqliteToolDetails = {
				...result,
				args,
				database: databasePath(ctx.cwd),
				metadataWarning,
				truncated: output.truncated,
			};

			if (result.code !== 0 || result.killed) {
				throw new Error(output.text);
			}

			return {
				content: [{ type: "text", text: output.text }],
				details,
			};
		},
		renderCall(args, theme) {
			const cliArgs = args.args?.length ? ` ${args.args.join(" ")}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("sqlite3 ")) + theme.fg("accent", DATABASE_FILE) + theme.fg("muted", cliArgs), 0, 0);
		},
	});

	pi.registerCommand("sqlite-init", {
		description: `Create ${DATABASE_FILE} and initialize its ${METADATA_TABLE} metadata table`,
		handler: async (_args, ctx) => {
			const existed = await databaseExists(ctx.cwd);

			try {
				await setupMetadataTable(ctx.cwd);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to initialize ${DATABASE_FILE}: ${message}`, "error");
				return;
			}

			syncSqliteToolVisibility(pi, true);
			ctx.ui.notify(existed ? `Initialized metadata in ${DATABASE_FILE}` : `Created ${DATABASE_FILE}`, "info");
		},
	});

	pi.registerCommand("agent-db", {
		description: `Dump the ${DATABASE_FILE} schema, table descriptions, and row counts`,
		handler: async (_args, ctx) => {
			const exists = await databaseExists(ctx.cwd);
			syncSqliteToolVisibility(pi, exists);
			if (!exists) {
				ctx.ui.notify(`${DATABASE_FILE} does not exist in ${ctx.cwd}. Run /sqlite-init first.`, "warning");
				return;
			}

			try {
				await insertDatabaseSummary(pi, ctx.cwd);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to summarize ${DATABASE_FILE}: ${message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		syncSqliteToolVisibility(pi, await databaseExists(ctx.cwd));
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		syncSqliteToolVisibility(pi, await databaseExists(ctx.cwd));
	});
}
