import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const OTHER_OPTION = "Other (type your own)";
const DONE_OPTION = "Done selecting";
const RECOMMENDED_SUFFIX = " (Recommended)";

const AskOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for this option" }),
	description: Type.Optional(Type.String({ description: "Optional description of this option" })),
});

const AskQuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable id for this question" })),
	question: Type.String({ description: "Question text to show the user" }),
	options: Type.Array(AskOptionSchema, { description: "Available options", minItems: 1 }),
	multi: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options" })),
	recommended: Type.Optional(Type.Number({ description: "Zero-based recommended option index" })),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow free-form user input. Defaults to true." })),
});

const AskParamsSchema = Type.Object({
	questions: Type.Array(AskQuestionSchema, { description: "Questions to ask the user", minItems: 1 }),
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

function optionDisplays(question: AskQuestion): OptionDisplay[] {
	return question.options.map((option, index) => {
		const base = option.description ? `${option.label} — ${option.description}` : option.label;
		const display = index === question.recommended ? `${base}${RECOMMENDED_SUFFIX}` : base;
		return { label: option.label, display };
	});
}

function defaultSelection(question: AskQuestion): string[] {
	if (question.options.length === 0) return [];
	const index = typeof question.recommended === "number" ? question.recommended : 0;
	const bounded = Math.max(0, Math.min(index, question.options.length - 1));
	return [question.options[bounded]?.label ?? question.options[0]?.label ?? ""];
}

async function askSingleChoice(question: AskQuestion, ctx: ExtensionContext): Promise<QuestionResult | undefined> {
	const displays = optionDisplays(question);
	const allowOther = question.allowOther !== false;
	const choices = allowOther ? [...displays.map(option => option.display), OTHER_OPTION] : displays.map(option => option.display);
	const choice = await ctx.ui.select(question.question, choices, { signal: ctx.signal });
	if (!choice) return undefined;

	if (choice === OTHER_OPTION) {
		const customInput = await ctx.ui.editor("Enter your response");
		if (customInput === undefined) return undefined;
		return {
			id: question.id ?? "question",
			question: question.question,
			multi: false,
			selectedOptions: [],
			customInput,
		};
	}

	const selected = displays.find(option => option.display === choice)?.label ?? choice.replace(RECOMMENDED_SUFFIX, "");
	return {
		id: question.id ?? "question",
		question: question.question,
		multi: false,
		selectedOptions: [selected],
	};
}

async function askMultiChoice(question: AskQuestion, ctx: ExtensionContext): Promise<QuestionResult | undefined> {
	const displays = optionDisplays(question);
	const allowOther = question.allowOther !== false;
	const selected = new Set<string>();
	let customInput: string | undefined;

	while (true) {
		const choices = displays.map(option => {
			const marker = selected.has(option.label) ? "[x]" : "[ ]";
			return `${marker} ${option.display}`;
		});
		if (selected.size > 0 || customInput !== undefined) choices.push(DONE_OPTION);
		if (allowOther) choices.push(OTHER_OPTION);

		const choice = await ctx.ui.select(question.question, choices, { signal: ctx.signal });
		if (!choice) return undefined;
		if (choice === DONE_OPTION) break;
		if (choice === OTHER_OPTION) {
			const input = await ctx.ui.editor("Enter your response", customInput);
			if (input !== undefined) customInput = input;
			break;
		}

		const displayIndex = choices.indexOf(choice);
		const option = displays[displayIndex];
		if (!option) continue;
		if (selected.has(option.label)) {
			selected.delete(option.label);
		} else {
			selected.add(option.label);
		}
	}

	return {
		id: question.id ?? "question",
		question: question.question,
		multi: true,
		selectedOptions: Array.from(selected),
		customInput,
	};
}

function formatResult(result: QuestionResult): string {
	if (result.customInput !== undefined) return `${result.id}: ${result.customInput}`;
	if (result.selectedOptions.length === 0) return `${result.id}: (no selection)`;
	if (result.multi) return `${result.id}: [${result.selectedOptions.join(", ")}]`;
	return `${result.id}: ${result.selectedOptions[0]}`;
}

export default function askExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user interactive multiple-choice or free-form questions while working. Use this to clarify requirements, gather preferences, or ask for decisions instead of guessing.",
		promptSnippet: "Ask the user interactive questions and return their answers.",
		promptGuidelines: [
			"Use ask when a user decision or clarification is needed and proceeding without input would risk doing the wrong work.",
		],
		parameters: AskParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text" as const, text: "Ask tool requires interactive mode." }],
					details: { results: [], cancelled: true } satisfies AskDetails,
				};
			}

			if (params.questions.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Ask tool requires at least one question." }],
					details: { results: [], cancelled: true } satisfies AskDetails,
				};
			}

			const results: QuestionResult[] = [];
			for (let index = 0; index < params.questions.length; index++) {
				const question = params.questions[index];
				const id = question.id ?? `question_${index + 1}`;
				const normalizedQuestion: AskQuestion = { ...question, id };
				const result = normalizedQuestion.multi
					? await askMultiChoice(normalizedQuestion, ctx)
					: await askSingleChoice(normalizedQuestion, ctx);

				if (!result) {
					return {
						content: [{ type: "text" as const, text: "User cancelled the ask dialog." }],
						details: { results, cancelled: true } satisfies AskDetails,
					};
				}
				if (result.selectedOptions.length === 0 && result.customInput === undefined) {
					result.selectedOptions = defaultSelection(normalizedQuestion);
				}
				results.push(result);
			}

			return {
				content: [{ type: "text" as const, text: `User answers:\n${results.map(formatResult).join("\n")}` }],
				details: { results, cancelled: false } satisfies AskDetails,
			};
		},
	});
}
