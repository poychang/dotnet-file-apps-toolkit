/**
 * Line bookkeeping and display-only normalization for tagged comment bodies. All offsets refer to the
 * original document text (UTF-16 code units, like `TextDocument.offsetAt`), and line breaks follow the
 * editor model: `\r\n`, `\n` or `\r`.
 */

export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          i++;
        }
        this.starts.push(i + 1);
      } else if (c === 10) {
        this.starts.push(i + 1);
      }
    }
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** Zero-based line containing `offset`. */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  lineStart(line: number): number {
    return this.starts[line];
  }
}

export interface BodyLine {
  /** Zero-based document line. */
  readonly sourceLine: number;
  /** Document offset where the displayed text of this line begins (after the removed indentation). */
  readonly sourceOffset: number;
  /** Displayed text without indentation removed by dedent and without the line break. */
  readonly text: string;
}

export interface NormalizedBody {
  /** Body for presentation: `\n` line breaks and common indentation removed. */
  readonly text: string;
  /** Common indentation removed from every non-blank line. */
  readonly indent: string;
  readonly lines: readonly BodyLine[];
}

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return a.slice(0, i);
}

/**
 * Splits `text[start, end)` into lines and removes their common leading whitespace. The removed
 * prefix must be identical on every non-blank line, so relative indentation (YAML, Python, Markdown
 * code blocks) is preserved and every displayed column maps to `sourceOffset + column`.
 */
export function normalizeBody(text: string, start: number, end: number, lines: LineIndex): NormalizedBody {
  const raw: { offset: number; text: string }[] = [];
  let i = start;
  while (i < end) {
    let j = i;
    while (j < end) {
      const c = text.charCodeAt(j);
      if (c === 10 || c === 13) {
        break;
      }
      j++;
    }
    raw.push({ offset: i, text: text.slice(i, j) });
    if (j >= end) {
      break;
    }
    i = text.charCodeAt(j) === 13 && text.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
  }

  let indent: string | undefined;
  for (const line of raw) {
    if (!isBlank(line.text)) {
      const lead = leadingWhitespace(line.text);
      indent = indent === undefined ? lead : commonPrefix(indent, lead);
    }
  }
  indent ??= '';

  const out: BodyLine[] = raw.map((line) => {
    let cut: number;
    if (line.text.startsWith(indent)) {
      cut = indent.length;
    } else {
      // Only blank lines can miss the common prefix; show them empty.
      cut = line.text.length;
    }
    return { sourceLine: lines.lineAt(line.offset), sourceOffset: line.offset + cut, text: line.text.slice(cut) };
  });
  return { text: out.map((l) => l.text).join('\n'), indent, lines: out };
}
