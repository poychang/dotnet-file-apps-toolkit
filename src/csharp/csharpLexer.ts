/**
 * A small, allocation-light C# lexer that only classifies the parts of a source file
 * that are *not* ordinary code: comments, string/char literals and preprocessor or
 * file-based-app directive lines. Everything between returned tokens is code.
 *
 * It follows the C# lexical rules that matter for locating real comment tokens:
 * regular, verbatim, raw (`"""`), interpolated (`$"`, `$@"`, `@$"`, `$$"""`) strings,
 * char literals, `//` and block comments (the first `*` + `/` always closes a block comment).
 */

export type CSharpTokenKind = 'lineComment' | 'blockComment' | 'string' | 'char' | 'directive';

export interface CSharpToken {
  readonly kind: CSharpTokenKind;
  /** Inclusive start offset in the original text. */
  readonly start: number;
  /** Exclusive end offset in the original text. */
  readonly end: number;
  /** False when the token runs to end-of-line/end-of-file without its closing delimiter. */
  readonly terminated: boolean;
}

const enum Ch {
  Tab = 9,
  LF = 10,
  VT = 11,
  FF = 12,
  CR = 13,
  Space = 32,
  Quote = 34,
  Hash = 35,
  Dollar = 36,
  Apostrophe = 39,
  OpenParen = 40,
  CloseParen = 41,
  Star = 42,
  Slash = 47,
  Colon = 58,
  At = 64,
  OpenBracket = 91,
  Backslash = 92,
  CloseBracket = 93,
  OpenBrace = 123,
  CloseBrace = 125,
  NBSP = 0xa0,
  BOM = 0xfeff,
}

function isNewline(c: number): boolean {
  return c === Ch.LF || c === Ch.CR || c === 0x85 || c === 0x2028 || c === 0x2029;
}

function isHorizontalWhitespace(c: number): boolean {
  return c === Ch.Space || c === Ch.Tab || c === Ch.VT || c === Ch.FF || c === Ch.NBSP || c === Ch.BOM;
}

function endOfLine(text: string, i: number): number {
  const n = text.length;
  while (i < n && !isNewline(text.charCodeAt(i))) {
    i++;
  }
  return i;
}

interface ScanResult {
  end: number;
  terminated: boolean;
}

class Lexer {
  private readonly n: number;

  constructor(private readonly text: string) {
    this.n = text.length;
  }

  lex(): CSharpToken[] {
    const tokens: CSharpToken[] = [];
    const { text, n } = this;
    let i = 0;
    let atLineStart = true;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (isNewline(c)) {
        atLineStart = true;
        i++;
        continue;
      }
      if (isHorizontalWhitespace(c)) {
        i++;
        continue;
      }
      if (c === Ch.Hash && atLineStart) {
        const end = endOfLine(text, i);
        tokens.push({ kind: 'directive', start: i, end, terminated: true });
        i = end;
        continue;
      }
      atLineStart = false;
      if (c === Ch.Slash) {
        const next = text.charCodeAt(i + 1);
        if (next === Ch.Slash) {
          const end = endOfLine(text, i);
          tokens.push({ kind: 'lineComment', start: i, end, terminated: true });
          i = end;
          continue;
        }
        if (next === Ch.Star) {
          const r = this.scanBlockComment(i);
          tokens.push({ kind: 'blockComment', start: i, end: r.end, terminated: r.terminated });
          i = r.end;
          continue;
        }
      }
      const str = this.tryScanString(i);
      if (str) {
        tokens.push({ kind: 'string', start: i, end: str.end, terminated: str.terminated });
        i = str.end;
        continue;
      }
      if (c === Ch.Apostrophe) {
        const r = this.scanChar(i);
        tokens.push({ kind: 'char', start: i, end: r.end, terminated: r.terminated });
        i = r.end;
        continue;
      }
      i++;
    }
    return tokens;
  }

  private scanBlockComment(start: number): ScanResult {
    const close = this.text.indexOf('*/', start + 2);
    return close < 0 ? { end: this.n, terminated: false } : { end: close + 2, terminated: true };
  }

  private scanChar(start: number): ScanResult {
    const { text, n } = this;
    let i = start + 1;
    // Char literals are short; bound the scan so a stray apostrophe cannot swallow a line.
    const limit = Math.min(n, start + 16);
    while (i < limit) {
      const c = text.charCodeAt(i);
      if (isNewline(c)) {
        return { end: i, terminated: false };
      }
      if (c === Ch.Backslash) {
        i += 2;
        continue;
      }
      if (c === Ch.Apostrophe) {
        return { end: i + 1, terminated: true };
      }
      i++;
    }
    return { end: Math.min(start + 1, n), terminated: false };
  }

  /** Returns undefined when the position does not start a string literal. */
  tryScanString(start: number): ScanResult | undefined {
    const { text } = this;
    let i = start;
    let dollars = 0;
    let verbatim = false;
    while (text.charCodeAt(i) === Ch.Dollar) {
      dollars++;
      i++;
    }
    if (text.charCodeAt(i) === Ch.At) {
      verbatim = true;
      i++;
      while (text.charCodeAt(i) === Ch.Dollar) {
        dollars++;
        i++;
      }
    }
    if (text.charCodeAt(i) !== Ch.Quote) {
      return undefined;
    }
    if (verbatim) {
      return this.scanVerbatim(i + 1, dollars > 0);
    }
    let quotes = 0;
    while (text.charCodeAt(i + quotes) === Ch.Quote) {
      quotes++;
    }
    if (quotes >= 3) {
      return this.scanRaw(i + quotes, quotes, dollars);
    }
    if (quotes === 2) {
      // Empty regular string.
      return { end: this.skipUtf8Suffix(i + 2), terminated: true };
    }
    return this.scanRegular(i + 1, dollars > 0);
  }

  private skipUtf8Suffix(i: number): number {
    const c = this.text.charCodeAt(i);
    if ((c === 0x75 || c === 0x55) && this.text.charCodeAt(i + 1) === 0x38) {
      return i + 2;
    }
    return i;
  }

  private scanRegular(i: number, interpolated: boolean): ScanResult {
    const { text, n } = this;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (isNewline(c)) {
        return { end: i, terminated: false };
      }
      if (c === Ch.Backslash) {
        i += 2;
        continue;
      }
      if (c === Ch.Quote) {
        return { end: this.skipUtf8Suffix(i + 1), terminated: true };
      }
      if (interpolated && c === Ch.OpenBrace) {
        if (text.charCodeAt(i + 1) === Ch.OpenBrace) {
          i += 2;
          continue;
        }
        i = this.scanHole(i + 1, 1);
        continue;
      }
      i++;
    }
    return { end: n, terminated: false };
  }

  private scanVerbatim(i: number, interpolated: boolean): ScanResult {
    const { text, n } = this;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === Ch.Quote) {
        if (text.charCodeAt(i + 1) === Ch.Quote) {
          i += 2;
          continue;
        }
        return { end: this.skipUtf8Suffix(i + 1), terminated: true };
      }
      if (interpolated && c === Ch.OpenBrace) {
        if (text.charCodeAt(i + 1) === Ch.OpenBrace) {
          i += 2;
          continue;
        }
        i = this.scanHole(i + 1, 1);
        continue;
      }
      i++;
    }
    return { end: n, terminated: false };
  }

  private scanRaw(i: number, quoteCount: number, dollars: number): ScanResult {
    const { text, n } = this;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === Ch.Quote) {
        let run = 0;
        while (text.charCodeAt(i + run) === Ch.Quote) {
          run++;
        }
        if (run >= quoteCount) {
          return { end: this.skipUtf8Suffix(i + run), terminated: true };
        }
        i += run;
        continue;
      }
      if (dollars > 0 && c === Ch.OpenBrace) {
        let run = 0;
        while (text.charCodeAt(i + run) === Ch.OpenBrace) {
          run++;
        }
        if (run >= dollars) {
          // Extra leading braces are literal content; the last `dollars` braces open the hole.
          i = this.scanHole(i + run, dollars);
        } else {
          i += run;
        }
        continue;
      }
      i++;
    }
    return { end: n, terminated: false };
  }

  /**
   * Scans an interpolation hole starting right after its opening brace(s).
   * Returns the offset right after the closing brace(s).
   */
  private scanHole(i: number, closeBraces: number): number {
    const { text, n } = this;
    let depth = 0;
    let parens = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === Ch.Slash && text.charCodeAt(i + 1) === Ch.Slash) {
        i = endOfLine(text, i);
        continue;
      }
      if (c === Ch.Slash && text.charCodeAt(i + 1) === Ch.Star) {
        i = this.scanBlockComment(i).end;
        continue;
      }
      if (c === Ch.Quote || c === Ch.Dollar || c === Ch.At) {
        const str = this.tryScanString(i);
        if (str) {
          i = str.end;
          continue;
        }
      }
      if (c === Ch.Apostrophe) {
        i = this.scanChar(i).end;
        continue;
      }
      if (c === Ch.OpenParen || c === Ch.OpenBracket) {
        parens++;
      } else if (c === Ch.CloseParen || c === Ch.CloseBracket) {
        parens = Math.max(0, parens - 1);
      } else if (c === Ch.OpenBrace) {
        depth++;
      } else if (c === Ch.CloseBrace) {
        if (depth === 0) {
          return this.consumeClosingBraces(i, closeBraces);
        }
        depth--;
      } else if (
        c === Ch.Colon &&
        depth === 0 &&
        parens === 0 &&
        text.charCodeAt(i + 1) !== Ch.Colon &&
        text.charCodeAt(i - 1) !== Ch.Colon
      ) {
        // Format specifier: literal text up to the closing brace(s).
        let j = i + 1;
        while (j < n && text.charCodeAt(j) !== Ch.CloseBrace) {
          if (closeBraces === 1 && (text.charCodeAt(j) === Ch.Quote || isNewline(text.charCodeAt(j)))) {
            break;
          }
          j++;
        }
        if (j < n && text.charCodeAt(j) === Ch.CloseBrace) {
          return this.consumeClosingBraces(j, closeBraces);
        }
        return j;
      }
      i++;
    }
    return n;
  }

  private consumeClosingBraces(i: number, closeBraces: number): number {
    let run = 0;
    while (run < closeBraces && this.text.charCodeAt(i + run) === Ch.CloseBrace) {
      run++;
    }
    return i + Math.max(run, 1);
  }
}

/** Lexes C# source text and returns comment, string, char and directive tokens in source order. */
export function lexCSharp(text: string): CSharpToken[] {
  return new Lexer(text).lex();
}

/**
 * Returns a copy of `text` where every non-code token is replaced by spaces, preserving
 * line breaks and offsets. Useful for structural heuristics over code only.
 */
export function maskNonCode(text: string, tokens: readonly CSharpToken[] = lexCSharp(text)): string {
  if (tokens.length === 0) {
    return text;
  }
  const parts: string[] = [];
  let last = 0;
  for (const t of tokens) {
    parts.push(text.slice(last, t.start));
    parts.push(text.slice(t.start, t.end).replace(/[^\r\n]/g, ' '));
    last = t.end;
  }
  parts.push(text.slice(last));
  return parts.join('');
}
