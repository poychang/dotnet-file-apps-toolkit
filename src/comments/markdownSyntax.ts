import type { BodyLine } from './normalization';

/**
 * Lightweight, line-based Markdown recognition used only for in-editor emphasis decorations. It is not a
 * CommonMark parser: it finds headings, list and quote markers, code, links, bold and italic spans so the
 * editor can style them without hiding any source characters.
 */

export type MarkdownDecorationKind = 'bold' | 'italic' | 'code' | 'link';

export interface MarkdownDecorationRange {
  readonly kind: MarkdownDecorationKind;
  /** Document offsets. */
  readonly start: number;
  readonly end: number;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}#{1,6}(?=[ \t]|$)/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^( {0,3})>/;
const LIST_RE = /^([ \t]*)([-+*]|\d{1,9}[.)])(?=[ \t]|$)/;
const CODE_SPAN_RE = /(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g;
const LINK_RE = /!?\[[^\]\n]*\]\([^)\s]*(?:[ \t]+"[^"\n]*")?\)|<(?:https?|mailto):[^>\s]+>|\bhttps?:\/\/[^\s<>()]+/g;
const STRONG_RE = /(\*\*|__)(?=\S)(.*?\S)\1/g;
const EMPHASIS_RE = /(?<![*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)|(?<![_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g;

function mask(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

export function markdownDecorationRanges(lines: readonly BodyLine[]): MarkdownDecorationRange[] {
  const out: MarkdownDecorationRange[] = [];
  const add = (kind: MarkdownDecorationKind, line: BodyLine, start: number, end: number) => {
    if (end > start) {
      out.push({ kind, start: line.sourceOffset + start, end: line.sourceOffset + end });
    }
  };

  let fence: { char: string; length: number } | undefined;
  for (const line of lines) {
    const text = line.text;
    const fenceMatch = FENCE_RE.exec(text);
    if (fence) {
      add('code', line, 0, text.trimEnd().length);
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && text.slice(fenceMatch[0].length).trim() === '') {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      add('code', line, 0, text.trimEnd().length);
      continue;
    }
    if (THEMATIC_BREAK_RE.test(text)) {
      add('bold', line, 0, text.trimEnd().length);
      continue;
    }

    let body = 0;
    const quote = QUOTE_RE.exec(text);
    if (quote) {
      add('bold', line, quote[1].length, quote[0].length);
      body = quote[0].length;
    }
    if (HEADING_RE.test(text.slice(body))) {
      add('bold', line, body, text.trimEnd().length);
    } else {
      const list = LIST_RE.exec(text.slice(body));
      if (list) {
        add('bold', line, body + list[1].length, body + list[0].length);
      }
    }
    decorateInline(text, (kind, s, e) => add(kind, line, s, e));
  }
  return out;
}

function decorateInline(text: string, add: (kind: MarkdownDecorationKind, start: number, end: number) => void): void {
  let masked = text;
  for (const m of text.matchAll(CODE_SPAN_RE)) {
    add('code', m.index, m.index + m[0].length);
    masked = mask(masked, m.index, m.index + m[0].length);
  }
  for (const m of masked.matchAll(LINK_RE)) {
    add('link', m.index, m.index + m[0].length);
  }
  for (const m of masked.matchAll(STRONG_RE)) {
    add('bold', m.index, m.index + m[0].length);
    masked = mask(masked, m.index, m.index + m[0].length);
  }
  for (const m of masked.matchAll(EMPHASIS_RE)) {
    add('italic', m.index, m.index + m[0].length);
  }
}
