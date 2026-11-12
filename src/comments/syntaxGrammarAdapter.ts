import type { StyledToken, TokenStyle } from './codeHighlighter';
import type { BodyLine } from './normalization';

/** A styled span in document offsets. */
export interface SourceStyledSpan {
  readonly start: number;
  readonly end: number;
  readonly key: string;
  readonly style: TokenStyle;
}

/** Stable identity of a style, used to share one decoration type per distinct style. */
export function styleKey(style: TokenStyle): string {
  return `${style.light ?? '-'}|${style.dark ?? '-'}|${style.fontStyle}`;
}

/**
 * Maps per-line tokens of a normalized body back to document offsets through the body's line map.
 * Adjacent tokens with the same style are merged so editors receive few, coalesced ranges. Columns past
 * the end of a line are clipped and at most `maxSpans` spans are produced.
 */
export function mapTokensToSource(
  lineMap: readonly BodyLine[],
  lines: readonly (readonly StyledToken[])[],
  maxSpans = Number.POSITIVE_INFINITY,
): SourceStyledSpan[] {
  const out: { start: number; end: number; key: string; style: TokenStyle }[] = [];
  const count = Math.min(lineMap.length, lines.length);
  for (let i = 0; i < count; i++) {
    const { sourceOffset, text } = lineMap[i];
    let previous: (typeof out)[number] | undefined;
    for (const token of lines[i]) {
      const start = Math.min(token.start, text.length);
      const end = Math.min(token.end, text.length);
      if (end <= start) {
        continue;
      }
      const key = styleKey(token.style);
      if (previous && previous.key === key && previous.end === sourceOffset + start) {
        previous.end = sourceOffset + end;
        continue;
      }
      if (out.length >= maxSpans) {
        return out;
      }
      previous = { start: sourceOffset + start, end: sourceOffset + end, key, style: token.style };
      out.push(previous);
    }
  }
  return out;
}
