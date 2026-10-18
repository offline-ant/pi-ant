import { parse, postprocess, preprocess } from "micromark";

type Span = { start: number; end: number };
type Event = ReturnType<typeof postprocess>[number];

/** Extract source, not rendered text. Concrete parser positions let us remove
 * only container syntax without reconstructing code, whitespace, or Markdown.
 */
export function extractQuotes(source: string): string[] {
  // The preprocessor discards a document BOM before assigning source offsets.
  if (source.startsWith("\uFEFF")) source = source.slice(1);
  const chunks = preprocess()(source, undefined, true);
  // Micromark expands a tab into a horizontal-tab chunk (-2) and virtual
  // spaces (-1); CRLF is one chunk (-3) covering two source characters.
  // Offsets alone cannot represent a partially consumed tab.
  const tabRemainders = new Map<number, number>();
  let offset = 0;
  for (const chunk of chunks) {
    if (chunk === -1) tabRemainders.set(offset - 1, (tabRemainders.get(offset - 1) ?? 0) + 1);
    else offset += typeof chunk === "string" ? chunk.length : chunk === null ? 0 : chunk === -3 ? 2 : 1;
  }
  const events = postprocess(parse().document().write(chunks));
  const quotes: string[] = [];
  let quoteDepth = 0;
  let listDepth = 0;
  let ancestorLists = 0;
  let start = 0;
  let removals: Span[] = [];
  let precedingIndent: Event | undefined;
  const listIndents = new Map<number, number>();

  const remove = (event: Event): void => {
    const [, token, context] = event;
    removals.push({ start: token.start.offset, end: token.end.offset });
    let offset = token.start.offset;
    for (const chunk of context.sliceStream(token)) {
      if (chunk === -1) tabRemainders.set(offset - 1, tabRemainders.get(offset - 1)! - 1);
      else offset += typeof chunk === "string" ? chunk.length : 1;
    }
  };

  for (const event of events) {
    const [kind, token] = event;
    const span = { start: token.start.offset, end: token.end.offset };
    if (token.type === "listOrdered" || token.type === "listUnordered") {
      listDepth += kind === "enter" ? 1 : -1;
    } else if (token.type === "blockQuote") {
      if (kind === "enter") {
        if (quoteDepth++ === 0) {
          start = span.start;
          ancestorLists = listDepth;
          removals = [];
        }
      } else if (--quoteDepth === 0) {
        let cursor = start;
        let text = "";
        for (const removal of removals.sort((a, b) => a.start - b.start)) {
          text += source.slice(cursor, Math.max(cursor, removal.start));
          for (let index = Math.max(cursor, removal.start); index < removal.end; index++) {
            if (source[index] === "\t") text += " ".repeat(tabRemainders.get(index) ?? 0);
          }
          cursor = Math.max(cursor, removal.end);
        }
        text += source.slice(cursor, span.end);
        if (text.trim()) quotes.push(text);
      }
    } else if (kind === "enter") {
      if (token.type === "linePrefix") {
        precedingIndent = event;
      } else if (token.type === "blockQuotePrefix" && quoteDepth > 0) {
        // Up to three optional spaces before a recognized quote marker belong
        // to its container, not to code or list content.
        if (precedingIndent?.[1].end.offset === span.start && precedingIndent[1].start.offset >= start) remove(precedingIndent);
        precedingIndent = undefined;
        remove(event);
      } else if (token.type === "listItemIndent") {
        // Continuation indentation is emitted from outermost list to innermost.
        // Strip surrounding lists, but retain lists *inside* the selected quote.
        const ordinal = (listIndents.get(token.start.line) ?? 0) + 1;
        listIndents.set(token.start.line, ordinal);
        if (quoteDepth > 0 && ordinal <= ancestorLists) remove(event);
      }
    }
  }
  return quotes;
}
