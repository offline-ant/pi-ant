import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	KeybindingsManager,
	Text,
	TUI_KEYBINDINGS,
	type Component,
	type KeybindingDefinitions,
	type SelectItem,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const OTHER_OPTION = "Other (type your own)";
const DONE_OPTION = "Done selecting";
const BACK_OPTION = "← Go back";
const RECOMMENDED_SUFFIX = " (Recommended)";
const CURRENT_SUFFIX = " (Current)";
const ASK_SELECTOR_KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"tui.select.edit": {
		defaultKeys: ["right", "ctrl+e"],
		description: "Edit selected item",
	},
} as const satisfies KeybindingDefinitions;

const AskOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for this option" }),
	description: Type.Optional(
		Type.String({ description: "Optional description of this option" }),
	),
});

const AskQuestionSchema = Type.Object({
	id: Type.Optional(
		Type.String({ description: "Stable id for this question" }),
	),
	question: Type.String({ description: "Question text to show the user" }),
	options: Type.Array(AskOptionSchema, {
		description: "Available options",
		minItems: 1,
	}),
	multi: Type.Optional(
		Type.Boolean({ description: "Allow selecting multiple options" }),
	),
	recommended: Type.Optional(
		Type.Number({ description: "Zero-based recommended option index" }),
	),
	allowOther: Type.Optional(
		Type.Boolean({
			description: "Allow free-form user input. Defaults to true.",
		}),
	),
});

const AskParamsSchema = Type.Object({
	questions: Type.Array(AskQuestionSchema, {
		description: "Questions to ask the user",
		minItems: 1,
	}),
});

type AskParams = Static<typeof AskParamsSchema>;
type AskQuestion = AskParams["questions"][number];

interface QuestionResult {
	id: string;
	question: string;
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

interface AskDetails {
	results: QuestionResult[];
	cancelled: boolean;
}

interface OptionDisplay {
	label: string;
	display: string;
}

type QuestionAction =
	| { action: "answered"; result: QuestionResult }
	| { action: "back" }
	| { action: "cancel" };

type AskChoiceValue =
	| { kind: "keep" }
	| { kind: "option"; label: string }
	| { kind: "done" }
	| { kind: "other" }
	| { kind: "back" };

interface AskPickerChoice {
	id: string;
	display: string;
	value: AskChoiceValue;
	editPrefill?: string;
}

interface AskListTheme {
	selectedText: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

type AskPickerResult =
	| { action: "selected"; choice: AskPickerChoice }
	| { action: "edit"; choice: AskPickerChoice }
	| { action: "cancel" };

function optionDisplays(
	question: AskQuestion,
	currentLabels?: Set<string>,
): OptionDisplay[] {
	return question.options.map((option, index) => {
		const base = option.description
			? `${option.label} — ${option.description}`
			: option.label;
		const recommended =
			index === question.recommended ? `${base}${RECOMMENDED_SUFFIX}` : base;
		const display = currentLabels?.has(option.label)
			? `${recommended}${CURRENT_SUFFIX}`
			: recommended;
		return { label: option.label, display };
	});
}

function defaultSelection(question: AskQuestion): string[] {
	if (question.options.length === 0) return [];
	const index =
		typeof question.recommended === "number" ? question.recommended : 0;
	const bounded = Math.max(0, Math.min(index, question.options.length - 1));
	return [question.options[bounded]?.label ?? question.options[0]?.label ?? ""];
}

function previewText(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= 60) return collapsed;
	return `${collapsed.slice(0, 57)}...`;
}

function answerPreview(result: QuestionResult): string {
	if (result.multi) {
		const answers = [...result.selectedOptions];
		if (result.customInput !== undefined) {
			answers.push(previewText(result.customInput) || "(empty)");
		}
		return answers.length > 0 ? `[${answers.join(", ")}]` : "(no selection)";
	}
	if (result.customInput !== undefined)
		return previewText(result.customInput) || "(empty)";
	return result.selectedOptions[0] ?? "(no selection)";
}

function cloneResult(result: QuestionResult): QuestionResult {
	return { ...result, selectedOptions: [...result.selectedOptions] };
}

function finalizedResult(
	result: QuestionResult,
	question: AskQuestion,
): QuestionResult {
	if (result.selectedOptions.length > 0 || result.customInput !== undefined)
		return result;
	return { ...result, selectedOptions: defaultSelection(question) };
}

function nextChoiceId(choices: AskPickerChoice[]): string {
	return `choice_${choices.length + 1}`;
}

function addChoice(
	choices: AskPickerChoice[],
	display: string,
	value: AskChoiceValue,
	editPrefill?: string,
): void {
	choices.push({
		id: nextChoiceId(choices),
		display,
		value,
		...(editPrefill !== undefined ? { editPrefill } : {}),
	});
}

function formatKeys(keys: string[]): string {
	return keys.length > 0 ? keys.join("/") : "unbound";
}

class WrappedAskList implements Component {
	private items: SelectItem[];
	private selectedIndex = 0;
	private maxVisible: number;
	private theme: AskListTheme;
	private keybindings: KeybindingsManager;

	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;

	constructor(
		items: SelectItem[],
		maxVisible: number,
		theme: AskListTheme,
		keybindings: KeybindingsManager,
	) {
		this.items = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.keybindings = keybindings;
	}

	invalidate(): void {
		// No cached state.
	}

	render(width: number): string[] {
		if (this.items.length === 0) {
			return [this.theme.noMatch("  No choices")];
		}

		const lines: string[] = [];
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.items.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			lines.push(...this.renderItem(item, i === this.selectedIndex, width));
		}

		if (startIndex > 0 || endIndex < this.items.length) {
			lines.push(
				this.theme.scrollInfo(`  (${this.selectedIndex + 1}/${this.items.length})`),
			);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		if (this.items.length === 0) return;
		if (this.keybindings.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0
				? this.items.length - 1
				: this.selectedIndex - 1;
			this.notifySelectionChange();
		} else if (this.keybindings.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.items.length - 1
				? 0
				: this.selectedIndex + 1;
			this.notifySelectionChange();
		} else if (this.keybindings.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.getSelectedItem();
			if (selectedItem) this.onSelect?.(selectedItem);
		} else if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}

	getSelectedItem(): SelectItem | null {
		return this.items[this.selectedIndex] ?? null;
	}

	private renderItem(item: SelectItem, isSelected: boolean, width: number): string[] {
		const prefix = isSelected ? "→ " : "  ";
		const prefixWidth = visibleWidth(prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		const wrapped = wrapTextWithAnsi(item.label || item.value, contentWidth);
		const continuationPrefix = " ".repeat(prefixWidth);

		return wrapped.map((line, index) => {
			const renderedLine = `${index === 0 ? prefix : continuationPrefix}${line}`;
			return isSelected ? this.theme.selectedText(renderedLine) : renderedLine;
		});
	}

	private notifySelectionChange(): void {
		const selectedItem = this.getSelectedItem();
		if (selectedItem) this.onSelectionChange?.(selectedItem);
	}
}

async function selectAskChoice(
	title: string,
	choices: AskPickerChoice[],
	ctx: ExtensionContext,
): Promise<AskPickerResult> {
	if (ctx.signal?.aborted) return { action: "cancel" };

	const result = await ctx.ui.custom<AskPickerResult>(
		(tui, theme, keybindings, done) => {
			const selectorKeybindings = new KeybindingsManager(
				ASK_SELECTOR_KEYBINDINGS,
				keybindings.getUserBindings(),
			);
			const choicesById = new Map(
				choices.map((choice) => [choice.id, choice]),
			);
			const items: SelectItem[] = choices.map((choice) => ({
				value: choice.id,
				label: choice.display,
			}));
			const list = new WrappedAskList(
				items,
				Math.min(items.length, 10),
				{
					selectedText: (text) => theme.fg("accent", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
				selectorKeybindings,
			);
			const selectCurrent = (item: SelectItem | null): void => {
				if (!item) return;
				const choice = choicesById.get(item.value);
				if (choice) done({ action: "selected", choice });
			};
			const editCurrent = (): void => {
				const item = list.getSelectedItem();
				if (!item) return;
				const choice = choicesById.get(item.value);
				if (choice?.editPrefill !== undefined) {
					done({ action: "edit", choice });
				}
			};
			const onAbort = (): void => done({ action: "cancel" });
			ctx.signal?.addEventListener("abort", onAbort, { once: true });

			list.onSelect = selectCurrent;
			list.onCancel = () => done({ action: "cancel" });

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			container.addChild(list);

			const hintParts = [
				`${formatKeys(selectorKeybindings.getKeys("tui.select.up"))}/${formatKeys(
					selectorKeybindings.getKeys("tui.select.down"),
				)} navigate`,
				`${formatKeys(selectorKeybindings.getKeys("tui.select.confirm"))} select`,
			];
			if (choices.some((choice) => choice.editPrefill !== undefined)) {
				hintParts.push(
					`${formatKeys(selectorKeybindings.getKeys("tui.select.edit"))} edit`,
				);
			}
			hintParts.push(
				`${formatKeys(selectorKeybindings.getKeys("tui.select.cancel"))} cancel`,
			);
			container.addChild(new Text(theme.fg("dim", hintParts.join("  ")), 1, 0));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (selectorKeybindings.matches(data, "tui.select.edit")) {
						editCurrent();
					} else {
						list.handleInput(data);
					}
					tui.requestRender();
				},
				dispose: () => ctx.signal?.removeEventListener("abort", onAbort),
			};
		},
	);
	return result ?? { action: "cancel" };
}

async function editSelectedAnswer(
	ctx: ExtensionContext,
	prefill: string,
): Promise<string | undefined> {
	return ctx.ui.editor("Edit selected answer", prefill);
}

async function askSingleChoice(
	question: AskQuestion,
	ctx: ExtensionContext,
	previous: QuestionResult | undefined,
	canGoBack: boolean,
): Promise<QuestionAction> {
	const currentLabels =
		previous?.customInput === undefined
			? new Set(previous?.selectedOptions ?? [])
			: undefined;
	const displays = optionDisplays(question, currentLabels);
	const allowOther = question.allowOther !== false;
	const keepChoice = previous
		? `Keep current answer: ${answerPreview(previous)}`
		: undefined;
	const otherChoice =
		previous?.customInput !== undefined
			? `${OTHER_OPTION} — Current: ${answerPreview(previous)}`
			: OTHER_OPTION;

	while (true) {
		const choices: AskPickerChoice[] = [];
		if (keepChoice) addChoice(choices, keepChoice, { kind: "keep" });
		for (const option of displays) {
			addChoice(
				choices,
				option.display,
				{ kind: "option", label: option.label },
				option.label,
			);
		}
		if (allowOther) {
			addChoice(
				choices,
				otherChoice,
				{ kind: "other" },
				previous?.customInput ?? "",
			);
		}
		if (canGoBack) addChoice(choices, BACK_OPTION, { kind: "back" });

		const choice = await selectAskChoice(question.question, choices, ctx);
		if (choice.action === "cancel")
			return ctx.signal?.aborted || !canGoBack
				? { action: "cancel" }
				: { action: "back" };

		if (choice.action === "edit") {
			const customInput = await editSelectedAnswer(
				ctx,
				choice.choice.editPrefill ?? "",
			);
			if (customInput === undefined) continue;
			return {
				action: "answered",
				result: {
					id: question.id ?? "question",
					question: question.question,
					multi: false,
					selectedOptions: [],
					customInput,
				},
			};
		}

		switch (choice.choice.value.kind) {
			case "back":
				return { action: "back" };
			case "keep":
				if (previous)
					return { action: "answered", result: cloneResult(previous) };
				continue;
			case "other": {
				const customInput = await ctx.ui.editor(
					"Enter your response",
					previous?.customInput,
				);
				if (customInput === undefined) continue;
				return {
					action: "answered",
					result: {
						id: question.id ?? "question",
						question: question.question,
						multi: false,
						selectedOptions: [],
						customInput,
					},
				};
			}
			case "option":
				return {
					action: "answered",
					result: {
						id: question.id ?? "question",
						question: question.question,
						multi: false,
						selectedOptions: [choice.choice.value.label],
					},
				};
			case "done":
				continue;
		}
	}
}

async function askMultiChoice(
	question: AskQuestion,
	ctx: ExtensionContext,
	previous: QuestionResult | undefined,
	canGoBack: boolean,
): Promise<QuestionAction> {
	const displays = optionDisplays(question);
	const allowOther = question.allowOther !== false;
	const selected = new Set(previous?.selectedOptions ?? []);
	const keepChoice = previous
		? `Keep current answer: ${answerPreview(previous)}`
		: undefined;
	let customInput = previous?.customInput;

	while (true) {
		const choices: AskPickerChoice[] = [];
		if (keepChoice) addChoice(choices, keepChoice, { kind: "keep" });
		for (const option of displays) {
			const marker = selected.has(option.label) ? "[x]" : "[ ]";
			addChoice(
				choices,
				`${marker} ${option.display}`,
				{ kind: "option", label: option.label },
				option.label,
			);
		}
		if (selected.size > 0 || customInput !== undefined) {
			addChoice(choices, DONE_OPTION, { kind: "done" });
		}
		if (allowOther) {
			addChoice(choices, OTHER_OPTION, { kind: "other" }, customInput ?? "");
		}
		if (canGoBack) addChoice(choices, BACK_OPTION, { kind: "back" });

		const choice = await selectAskChoice(question.question, choices, ctx);
		if (choice.action === "cancel")
			return ctx.signal?.aborted || !canGoBack
				? { action: "cancel" }
				: { action: "back" };

		if (choice.action === "edit") {
			const input = await editSelectedAnswer(
				ctx,
				choice.choice.editPrefill ?? "",
			);
			if (input === undefined) continue;
			customInput = input;
			if (choice.choice.value.kind === "option") {
				selected.delete(choice.choice.value.label);
			}
			break;
		}

		switch (choice.choice.value.kind) {
			case "back":
				return { action: "back" };
			case "keep":
				if (previous)
					return { action: "answered", result: cloneResult(previous) };
				continue;
			case "done":
				break;
			case "other": {
				const input = await ctx.ui.editor("Enter your response", customInput);
				if (input === undefined) continue;
				customInput = input;
				break;
			}
			case "option":
				if (selected.has(choice.choice.value.label)) {
					selected.delete(choice.choice.value.label);
				} else {
					selected.add(choice.choice.value.label);
				}
				continue;
		}
		break;
	}

	return {
		action: "answered",
		result: {
			id: question.id ?? "question",
			question: question.question,
			multi: true,
			selectedOptions: Array.from(selected),
			customInput,
		},
	};
}

function formatResult(result: QuestionResult): string {
	if (result.multi) {
		const answers = [...result.selectedOptions];
		if (result.customInput !== undefined) answers.push(result.customInput);
		return answers.length > 0
			? `${result.id}: [${answers.join(", ")}]`
			: `${result.id}: (no selection)`;
	}
	if (result.customInput !== undefined)
		return `${result.id}: ${result.customInput}`;
	return `${result.id}: ${result.selectedOptions[0] ?? "(no selection)"}`;
}

export default function askExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user interactive multiple-choice or free-form questions while working. Use this to clarify requirements, gather preferences, or ask for decisions instead of guessing.",
		promptSnippet:
			"Ask the user interactive questions and return their answers.",
		promptGuidelines: [
			"Use ask when a user decision or clarification is needed and proceeding without input would risk doing the wrong work.",
		],
		parameters: AskParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Ask tool requires interactive mode.",
						},
					],
					details: { results: [], cancelled: true } satisfies AskDetails,
				};
			}

			if (params.questions.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Ask tool requires at least one question.",
						},
					],
					details: { results: [], cancelled: true } satisfies AskDetails,
				};
			}

			const results: QuestionResult[] = [];
			let index = 0;
			while (index < params.questions.length) {
				const question = params.questions[index];
				const id = question.id ?? `question_${index + 1}`;
				const normalizedQuestion: AskQuestion = { ...question, id };
				const action = normalizedQuestion.multi
					? await askMultiChoice(
							normalizedQuestion,
							ctx,
							results[index],
							index > 0,
						)
					: await askSingleChoice(
							normalizedQuestion,
							ctx,
							results[index],
							index > 0,
						);

				if (action.action === "back") {
					index = Math.max(0, index - 1);
					continue;
				}

				if (action.action === "cancel") {
					return {
						content: [
							{ type: "text" as const, text: "User cancelled the ask dialog." },
						],
						details: {
							results: results.slice(0, index),
							cancelled: true,
						} satisfies AskDetails,
					};
				}

				results[index] = finalizedResult(action.result, normalizedQuestion);
				index++;
			}

			const completedResults = results.slice(0, params.questions.length);
			return {
				content: [
					{
						type: "text" as const,
						text: `User answers:\n${completedResults.map(formatResult).join("\n")}`,
					},
				],
				details: {
					results: completedResults,
					cancelled: false,
				} satisfies AskDetails,
			};
		},
	});
}
