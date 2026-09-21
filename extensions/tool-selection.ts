/** Branch entry recording the session's enabled tools; its data is `{ enabledTools }`. */
export const TOOL_SELECTION_ENTRY = "pi-ant:tool-selection";

export function parseToolSelection(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null || !("enabledTools" in value)) return undefined;
  const { enabledTools } = value;
  if (!Array.isArray(enabledTools) || !enabledTools.every((tool) => typeof tool === "string")) return undefined;
  return [...new Set(enabledTools)];
}

export function toggleTool(selection: readonly string[], name: string): string[] {
  return selection.includes(name) ? selection.filter((tool) => tool !== name) : [...selection, name];
}

export function sameToolSelection(left: readonly string[], right: readonly string[]): boolean {
  const rightTools = new Set(right);
  return left.length === rightTools.size && left.every((tool) => rightTools.has(tool));
}

export function activeTools(selection: readonly string[], availableTools: Iterable<string>, requiredTools: Iterable<string>): string[] {
  const available = new Set(availableTools);
  return [...new Set([...selection, ...requiredTools])].filter((tool) => available.has(tool));
}
