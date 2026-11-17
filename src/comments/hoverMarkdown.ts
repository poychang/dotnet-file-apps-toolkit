import MarkdownIt, { type Token } from 'markdown-it';
import { replaceOutsideCodeSpans } from './markdownRenderer';

type Align = 'left' | 'center' | 'right';

/** Box-drawn tables wider than this many monospace columns would wrap in a hover, so they stay plain tables. */
export const MAX_HOVER_TABLE_WIDTH = 60;

/**
 * Left bar for quotes. VS Code keeps `<span>` tags in a hover only when `MarkdownString.isTrusted` is set,
 * and its sanitizer only keeps `color`, `background-color` and `border-radius` styles (VS Code 1.100+).
 */
export const QUOTE_BAR = '<span style="background-color:var(--vscode-textBlockQuote-border);">&nbsp;</span>&nbsp;&nbsp;';

const parser = new MarkdownIt({ html: true });
const SPAN_TAG_RE = /<\/?span\b[^>]*>/gi;
const WIDE_CHAR_RE =
  /^[\p{Emoji_Presentation}\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]$/u;
const ZERO_WIDTH_CHAR_RE = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/**
 * Adapts tagged Markdown to VS Code's native hover, whose CSS shows tables without borders and indents
 * quotes on both sides: top-level tables become box-drawn text blocks and top-level quotes that only hold
 * paragraphs get a theme-colored bar. Raw `<span>` tags from the comment are removed outside code, so the
 * trusted hover still renders no raw HTML from the comment.
 */
export function prepareHoverMarkdown(markdown: string): string {
  const tokens = parser.parse(markdown, {});
  const codeLines = new Set<number>();
  for (const token of tokens) {
    if ((token.type === 'fence' || token.type === 'code_block') && token.map) {
      for (let line = token.map[0]; line < token.map[1]; line++) {
        codeLines.add(line);
      }
    }
  }
  const lines = markdown
    .split('\n')
    .map((line, n) => (codeLines.has(n) ? line : replaceOutsideCodeSpans(line, (text) => text.replace(SPAN_TAG_RE, ''))));

  const edits: { start: number; end: number; lines: string[] }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.level !== 0 || !open.map || (open.type !== 'table_open' && open.type !== 'blockquote_open')) {
      continue;
    }
    let close = i + 1;
    while (close < tokens.length && tokens[close].level !== 0) {
      close++;
    }
    const [start, end] = open.map;
    const inner = tokens.slice(i + 1, close);
    if (open.type === 'table_open') {
      const table = boxTable(inner);
      if (table) {
        edits.push({ start, end, lines: table });
      }
    } else {
      const quote = barQuote(inner, lines.slice(start, end));
      if (quote) {
        // Blank lines keep the bar lines from joining a neighboring paragraph.
        const before = start > 0 && lines[start - 1].trim() !== '' ? [''] : [];
        const after = end < lines.length && lines[end].trim() !== '' ? [''] : [];
        edits.push({ start, end, lines: [...before, ...quote, ...after] });
      }
    }
    i = close;
  }
  for (const edit of edits.reverse()) {
    lines.splice(edit.start, edit.end - edit.start, ...edit.lines);
  }
  return lines.join('\n');
}

/** Monospace columns of `text`: East Asian wide characters and emoji take two, combining marks none. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += ZERO_WIDTH_CHAR_RE.test(ch) ? 0 : WIDE_CHAR_RE.test(ch) ? 2 : 1;
  }
  return width;
}

function boxTable(tokens: readonly Token[]): string[] | undefined {
  const rows: string[][] = [];
  const aligns: Align[] = [];
  for (const token of tokens) {
    if (token.type === 'tr_open') {
      rows.push([]);
    } else if (token.type === 'th_open') {
      const align = /text-align:\s*(left|center|right)/.exec(String(token.attrGet('style') ?? ''))?.[1];
      aligns.push((align as Align | undefined) ?? 'left');
    } else if (token.type === 'inline') {
      rows[rows.length - 1]?.push(inlineText(token.children ?? []));
    }
  }
  if (rows.length === 0 || aligns.length === 0) {
    return undefined;
  }
  const widths = aligns.map((_, c) => Math.max(...rows.map((row) => displayWidth(row[c] ?? ''))));
  if (widths.reduce((sum, w) => sum + w + 3, 1) > MAX_HOVER_TABLE_WIDTH) {
    return undefined;
  }
  const rule = (left: string, middle: string, right: string): string =>
    left + widths.map((w) => '─'.repeat(w + 2)).join(middle) + right;
  const row = (cells: readonly string[]): string =>
    `│${widths.map((w, c) => ` ${pad(cells[c] ?? '', w, aligns[c])} `).join('│')}│`;
  const [header, ...body] = rows;
  return [
    '```text',
    rule('┌', '┬', '┐'),
    row(header),
    ...(body.length > 0 ? [rule('├', '┼', '┤'), ...body.map(row)] : []),
    rule('└', '┴', '┘'),
    '```',
  ];
}

function inlineText(tokens: readonly Token[]): string {
  let text = '';
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'text_special' || token.type === 'code_inline') {
      text += token.content;
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      text += ' ';
    } else if (token.type === 'image') {
      text += inlineText(token.children ?? []);
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

function pad(text: string, width: number, align: Align): string {
  const space = width - displayWidth(text);
  const left = align === 'right' ? space : align === 'center' ? Math.floor(space / 2) : 0;
  return ' '.repeat(left) + text + ' '.repeat(space - left);
}

/** Each source line gets its own bar and a hard break, since a bar cannot span wrapped lines. */
function barQuote(tokens: readonly Token[], source: readonly string[]): string[] | undefined {
  if (tokens.some((t) => t.type !== 'paragraph_open' && t.type !== 'paragraph_close' && t.type !== 'inline')) {
    return undefined;
  }
  const text = source.map((line) => line.replace(/^ {0,3}>[ \t]?/, '').trim());
  return text.map((line, k) => {
    if (line === '') {
      return '';
    }
    const next = text[k + 1];
    const hardBreak = next !== undefined && next !== '' && !line.endsWith('\\') ? '  ' : '';
    return QUOTE_BAR + line + hardBreak;
  });
}
