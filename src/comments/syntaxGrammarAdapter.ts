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
  return `${style.light ?? '-'}|${style.dark ?? '-'}|${style.fontStyle}${style.foreground ? '|fg' : ''}${style.themeColor ? `|${style.themeColor}` : ''}`;
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

/** Replaces overlapping token styles with `overrides`, splitting the base token ranges as needed. */
export function overlayTokenStyles(
  baseLines: readonly (readonly StyledToken[])[],
  overrides: readonly (readonly StyledToken[])[],
): StyledToken[][] {
  const lineCount = Math.max(baseLines.length, overrides.length);
  const out: StyledToken[][] = [];
  for (let i = 0; i < lineCount; i++) {
    const base = baseLines[i] ?? [];
    const over = overrides[i] ?? [];
    const boundaries = [...new Set([...base, ...over].flatMap((t) => [t.start, t.end]))].sort((a, b) => a - b);
    const line: StyledToken[] = [];
    let baseIndex = 0;
    let overIndex = 0;
    for (let j = 0; j + 1 < boundaries.length; j++) {
      const start = boundaries[j];
      const end = boundaries[j + 1];
      while (baseIndex < base.length && base[baseIndex].end <= start) {
        baseIndex++;
      }
      while (overIndex < over.length && over[overIndex].end <= start) {
        overIndex++;
      }
      const override = over[overIndex];
      const token = base[baseIndex];
      const style =
        override && override.start <= start && override.end >= end
          ? override.style
          : token && token.start <= start && token.end >= end
            ? token.style
            : undefined;
      if (!style || end <= start) {
        continue;
      }
      const previous = line[line.length - 1];
      if (previous && previous.end === start && styleKey(previous.style) === styleKey(style)) {
        line[line.length - 1] = { start: previous.start, end, style: previous.style };
      } else {
        line.push({ start, end, style });
      }
    }
    out.push(line);
  }
  return out;
}
