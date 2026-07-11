export type ReadingBlockKind =
	| "heading"
	| "prose"
	| "list"
	| "code"
	| "table"
	| "quote"
	| "thematic";

interface ReadingBlock {
	kind: ReadingBlockKind;
	text: string;
	startLine: number;
	endLine: number;
	weight: number;
}

export interface ReadingUnit {
	number: number;
	text: string;
	startLine: number;
	endLine: number;
	sentenceWeight: number;
}

const MIN_UNIT_WEIGHT = 3;
const MAX_UNIT_WEIGHT = 6;

function isBlank(line: string): boolean {
	return line.trim().length === 0;
}

function isHeading(line: string): boolean {
	return /^ {0,3}#{1,6}(?:\s+|$)/.test(line);
}

function fenceMarker(line: string): string | undefined {
	const match = line.match(/^\s*(`{3,}|~{3,})/);
	return match?.[1];
}

function isFenceClose(line: string, marker: string): boolean {
	const character = marker[0];
	if (!character) return false;
	const match = line.match(/^\s*(`+|~+)\s*$/);
	return match?.[1]?.[0] === character && match[1].length >= marker.length;
}

function listIndent(line: string): number | undefined {
	const match = line.match(/^( {0,3})(?:[-+*]|\d+[.)])\s+/);
	return match?.[1]?.length;
}

function isListStart(line: string): boolean {
	return listIndent(line) !== undefined;
}

function isBlockquote(line: string): boolean {
	return /^ {0,3}>/.test(line);
}

function isThematicBreak(line: string): boolean {
	return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function isIndentedCode(line: string): boolean {
	return /^(?: {4}|\t)/.test(line);
}

function isTableDelimiter(line: string): boolean {
	return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isSpecialBlockStart(lines: string[], index: number): boolean {
	const line = lines[index] ?? "";
	return (
		isHeading(line) ||
		fenceMarker(line) !== undefined ||
		isListStart(line) ||
		isBlockquote(line) ||
		isThematicBreak(line) ||
		isIndentedCode(line) ||
		(index + 1 < lines.length && line.includes("|") && isTableDelimiter(lines[index + 1] ?? ""))
	);
}

function sentenceCount(text: string): number {
	const normalized = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/~~~[\s\S]*?~~~/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/\[[^\]]*\]\([^)]*\)/g, " ")
		.trim();
	if (!normalized) return 0;
	const endings = normalized.match(/[.!?]+(?:["')\]]+)?(?=\s|$)/g)?.length ?? 0;
	return Math.max(1, endings);
}

function blockWeight(kind: ReadingBlockKind, text: string): number {
	const nonEmptyLines = text.split("\n").filter((line) => !isBlank(line)).length;
	switch (kind) {
		case "heading":
			return 0;
		case "prose":
		case "quote":
			return Math.min(10, sentenceCount(text));
		case "list": {
			const itemCount = text.split("\n").filter(isListStart).length;
			return Math.min(10, Math.max(1, sentenceCount(text), Math.ceil(itemCount / 2)));
		}
		case "code":
			return Math.min(10, Math.max(1, Math.ceil(nonEmptyLines / 4)));
		case "table":
			return Math.min(10, Math.max(1, Math.ceil(Math.max(1, nonEmptyLines - 2) / 2)));
		case "thematic":
			return 1;
	}
}

function makeBlock(
	kind: ReadingBlockKind,
	lines: string[],
	startIndex: number,
	endIndex: number,
): ReadingBlock {
	const text = lines.slice(startIndex, endIndex + 1).join("\n").trimEnd();
	return {
		kind,
		text,
		startLine: startIndex + 1,
		endLine: endIndex + 1,
		weight: blockWeight(kind, text),
	};
}

function nextNonBlank(lines: string[], index: number): number {
	let cursor = index;
	while (cursor < lines.length && isBlank(lines[cursor] ?? "")) cursor++;
	return cursor;
}

function parseBlocks(document: string): ReadingBlock[] {
	const lines = document.replace(/\r\n?/g, "\n").split("\n");
	const blocks: ReadingBlock[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (isBlank(line)) {
			index++;
			continue;
		}

		const marker = fenceMarker(line);
		if (marker) {
			let end = index + 1;
			while (end < lines.length && !isFenceClose(lines[end] ?? "", marker)) end++;
			if (end < lines.length) end++;
			blocks.push(makeBlock("code", lines, index, Math.max(index, end - 1)));
			index = end;
			continue;
		}

		if (isHeading(line)) {
			blocks.push(makeBlock("heading", lines, index, index));
			index++;
			continue;
		}

		if (isThematicBreak(line)) {
			blocks.push(makeBlock("thematic", lines, index, index));
			index++;
			continue;
		}

		if (index + 1 < lines.length && line.includes("|") && isTableDelimiter(lines[index + 1] ?? "")) {
			let end = index + 2;
			while (end < lines.length && !isBlank(lines[end] ?? "") && (lines[end] ?? "").includes("|")) end++;
			blocks.push(makeBlock("table", lines, index, end - 1));
			index = end;
			continue;
		}

		if (isListStart(line)) {
			const baseIndent = listIndent(line) ?? 0;
			let end = index + 1;
			while (end < lines.length) {
				const candidate = lines[end] ?? "";
				const candidateIndent = listIndent(candidate);
				if (candidateIndent !== undefined && candidateIndent <= baseIndent) break;
				if (!isBlank(candidate)) {
					if (candidateIndent !== undefined || /^\s+\S/.test(candidate)) {
						end++;
						continue;
					}
					break;
				}

				const next = nextNonBlank(lines, end);
				const nextLine = lines[next] ?? "";
				const nextIndent = listIndent(nextLine);
				if (
					next < lines.length &&
					((nextIndent !== undefined && nextIndent > baseIndent) || /^\s+\S/.test(nextLine))
				) {
					end = next;
					continue;
				}
				break;
			}
			blocks.push(makeBlock("list", lines, index, end - 1));
			index = end;
			continue;
		}

		if (isBlockquote(line)) {
			let end = index + 1;
			while (end < lines.length) {
				const candidate = lines[end] ?? "";
				if (isBlockquote(candidate)) {
					end++;
					continue;
				}
				if (isBlank(candidate)) {
					const next = nextNonBlank(lines, end);
					if (next < lines.length && isBlockquote(lines[next] ?? "")) {
						end = next;
						continue;
					}
				}
				break;
			}
			blocks.push(makeBlock("quote", lines, index, end - 1));
			index = end;
			continue;
		}

		if (isIndentedCode(line)) {
			let end = index + 1;
			while (end < lines.length) {
				const candidate = lines[end] ?? "";
				if (isIndentedCode(candidate)) {
					end++;
					continue;
				}
				if (isBlank(candidate)) {
					const next = nextNonBlank(lines, end);
					if (next < lines.length && isIndentedCode(lines[next] ?? "")) {
						end = next;
						continue;
					}
				}
				break;
			}
			blocks.push(makeBlock("code", lines, index, end - 1));
			index = end;
			continue;
		}

		let end = index + 1;
		while (end < lines.length && !isBlank(lines[end] ?? "") && !isSpecialBlockStart(lines, end)) end++;
		blocks.push(makeBlock("prose", lines, index, end - 1));
		index = end;
	}

	return blocks;
}

function chunkBlocks(blocks: ReadingBlock[]): ReadingBlock[][] {
	const chunks: ReadingBlock[][] = [];
	let current: ReadingBlock[] = [];
	let weight = 0;

	const flush = (): void => {
		if (current.length === 0) return;
		chunks.push(current);
		current = [];
		weight = 0;
	};

	for (const block of blocks) {
		if (block.kind === "heading") {
			if (weight >= MIN_UNIT_WEIGHT) flush();
			current.push(block);
			continue;
		}
		if (current.length > 0 && weight >= MIN_UNIT_WEIGHT && weight + block.weight > MAX_UNIT_WEIGHT) {
			flush();
		}
		current.push(block);
		weight += block.weight;
		if (weight >= MAX_UNIT_WEIGHT) flush();
	}
	flush();

	if (chunks.length > 1) {
		const trailing = chunks[chunks.length - 1];
		const trailingWeight = trailing?.reduce((total, block) => total + block.weight, 0) ?? 0;
		if (trailing && trailingWeight < MIN_UNIT_WEIGHT) {
			const previous = chunks[chunks.length - 2];
			if (previous) {
				previous.push(...trailing);
				chunks.pop();
			}
		}
	}
	return chunks;
}

function joinChunkBlocks(blocks: ReadingBlock[]): string {
	let text = "";
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (!block) continue;
		const previous = blocks[index - 1];
		const separator = previous?.kind === "list" && block.kind === "list" ? "\n" : "\n\n";
		text += `${index === 0 ? "" : separator}${block.text}`;
	}
	return text;
}

export function segmentReadingUnits(document: string): ReadingUnit[] {
	const chunks = chunkBlocks(parseBlocks(document));
	return chunks.map((chunk, index) => ({
		number: index + 1,
		text: joinChunkBlocks(chunk),
		startLine: chunk[0]?.startLine ?? 1,
		endLine: chunk[chunk.length - 1]?.endLine ?? 1,
		sentenceWeight: chunk.reduce((total, block) => total + block.weight, 0),
	}));
}
