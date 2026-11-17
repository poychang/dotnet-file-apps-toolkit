import { MAX_HIGHLIGHT_CHARS, type StyledToken } from './codeHighlighter';
import type { BodyLine } from './normalization';

const DEFAULT_STYLE = { fontStyle: 0, foreground: true } as const;

interface OpenBracket {
  readonly char: '{' | '[';
  readonly line: number;
  readonly token: number;
}

function bracketStyle(depth: number): StyledToken['style'] {
  return { fontStyle: 0, themeColor: `editorBracketHighlight.foreground${(depth % 6) + 1}` };
}

/** Styles JSON separators with the editor foreground and colors matched bracket pairs by nesting depth. */
export function jsonBracketPairTokens(lines: readonly BodyLine[], colorPairs = true): StyledToken[][] {
  const output: StyledToken[][] = lines.map(() => []);
  let remaining = MAX_HIGHLIGHT_CHARS;
  for (const line of lines) {
    remaining -= line.text.length;
    if (remaining < 0) {
      return output;
    }
  }
  const stack: OpenBracket[] = [];
  let inString = false;
  let escaped = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const text = lines[lineIndex].text;
    for (let column = 0; column < text.length; column++) {
      const char = text[column];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === ':' || char === ',') {
        output[lineIndex].push({ start: column, end: column + 1, style: DEFAULT_STYLE });
        continue;
      }
      if (char !== '{' && char !== '[' && char !== '}' && char !== ']') {
        continue;
      }

      const tokenIndex = output[lineIndex].length;
      output[lineIndex].push({ start: column, end: column + 1, style: DEFAULT_STYLE });
      if (char === '{' || char === '[') {
        stack.push({ char, line: lineIndex, token: tokenIndex });
        continue;
      }

      const open = stack[stack.length - 1];
      if (colorPairs && open && ((open.char === '{' && char === '}') || (open.char === '[' && char === ']'))) {
        const style = bracketStyle(stack.length - 1);
        stack.pop();
        const openingToken = output[open.line][open.token];
        output[open.line][open.token] = { ...openingToken, style };
        output[lineIndex][tokenIndex] = { ...output[lineIndex][tokenIndex], style };
      }
    }
    inString = false;
    escaped = false;
  }
  return output;
}
