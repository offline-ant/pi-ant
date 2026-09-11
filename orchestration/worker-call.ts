import { Text } from "@earendil-works/pi-tui";

/** Display worker arguments as text, not JSON-escaped prompt strings. */
export function renderWorkerCall(name: string, args: Record<string, unknown>): Text {
  const lines = [`${name}(`];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const valueLines = value.replace(/\r\n/g, "\n").split("\n");
      if (valueLines.length > 1) {
        lines.push(`  ${key}:`, ...valueLines.map((line) => `    ${line}`));
      } else {
        lines.push(`  ${key}: ${value}`);
      }
    } else {
      lines.push(`  ${key}: ${JSON.stringify(value) ?? String(value)}`);
    }
  }
  lines.push(")");
  return new Text(lines.join("\n"), 0, 0);
}
