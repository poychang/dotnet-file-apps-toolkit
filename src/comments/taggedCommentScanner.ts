import { lexCSharp } from '../csharp/csharpLexer';
import { defaultRegistry, TAG_PATTERN, type EmbeddedLanguageDescriptor, type EmbeddedLanguageRegistry, type RenderMode } from './embeddedLanguageRegistry';
import { LineIndex, normalizeBody, type BodyLine } from './normalization';

/**
 * A C# block comment that opens with an explicit, known language tag on its own line:
 *
 * ```text
 * /*yaml
 * key: value
 * *\/
 * ```
 *
 * Offsets are in original-document UTF-16 code units; lines are zero-based.
 */
export interface TaggedCommentBlock {
  /** Position of the block in the scan result. */
  readonly index: number;
  /** Canonical language ID. */
  readonly language: string;
  readonly descriptor: EmbeddedLanguageDescriptor;
  readonly mode: RenderMode;
  /** Tag as written in the source, e.g. `YML`. */
  readonly tag: string;
  /** Offset of `/*`. */
  readonly startOffset: number;
  /** Offset right after `*\/`, or the end of the text for an unterminated comment. */
  readonly endOffset: number;
  readonly tagStartOffset: number;
  readonly tagEndOffset: number;
  /** First body character: the line after the opening tag line. */
  readonly bodyStartOffset: number;
  /**
   * End of the body (exclusive). When `*\/` sits on its own line, that line's indentation belongs to the
   * closing delimiter, so the body ends after the last content line break.
   */
  readonly bodyEndOffset: number;
  readonly startLine: number;
  readonly endLine: number;
  /** False when the comment has no closing `*\/` (it then runs to the end of the file). */
  readonly terminated: boolean;
  /** Exact source text of the body (`text.slice(bodyStartOffset, bodyEndOffset)`). */
  readonly rawBody: string;
  /** Display text with `\n` line breaks and common indentation removed. */
  readonly normalizedBody: string;
  /** One entry per line of `normalizedBody`, mapping it back to the document. */
  readonly lineMap: readonly BodyLine[];
}

/** A comment shaped like a tagged block whose tag is not in the registry. */
export interface UnknownTag {
  readonly tag: string;
  readonly tagStartOffset: number;
  readonly tagEndOffset: number;
  readonly startLine: number;
}

export interface TaggedCommentScan {
  readonly blocks: readonly TaggedCommentBlock[];
  readonly unknownTags: readonly UnknownTag[];
  /** True when more than `maxBlocks` tagged comments exist; the rest are ignored. */
  readonly truncated: boolean;
}

export interface ScanOptions {
  readonly registry?: EmbeddedLanguageRegistry;
  readonly maxBlocks?: number;
}

export const DEFAULT_MAX_BLOCKS = 1000;

interface Opening {
  readonly tag: string;
  readonly tagStart: number;
  readonly tagEnd: number;
  readonly bodyStart: number;
}

/**
 * Parses `/*<tag>[ \t]*<EOL>` at `start`. Returns undefined for ordinary comments, including `/**`,
 * `/* text`, `/*tag text` and single-line `/*tag *\/`.
 */
function parseOpening(text: string, start: number, end: number): Opening | undefined {
  const tagStart = start + 2;
  TAG_PATTERN.lastIndex = tagStart;
  const m = TAG_PATTERN.exec(text);
  if (!m) {
    return undefined;
  }
  const tagEnd = Math.min(tagStart + m[0].length, end);
  let i = tagEnd;
  while (i < end && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) {
    i++;
  }
  if (i >= end) {
    return undefined;
  }
  const c = text.charCodeAt(i);
  if (c === 13) {
    return { tag: text.slice(tagStart, tagEnd), tagStart, tagEnd, bodyStart: text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1 };
  }
  if (c === 10) {
    return { tag: text.slice(tagStart, tagEnd), tagStart, tagEnd, bodyStart: i + 1 };
  }
  return undefined;
}

/** End of the body: drops the whitespace-only prefix of the line that holds `*\/`. */
function bodyEnd(text: string, bodyStart: number, close: number): number {
  let i = close;
  while (i > bodyStart) {
    const c = text.charCodeAt(i - 1);
    if (c === 10 || c === 13) {
      return i;
    }
    if (c !== 32 && c !== 9) {
      return close;
    }
    i--;
  }
  return bodyStart;
}

/**
 * Finds explicitly tagged block comments. Only real C# comment tokens are considered: `/*yaml` inside
 * strings (regular, verbatim, raw, interpolated), chars or `//` comments is ignored, and the first `*\/`
 * always closes the comment.
 */
export function scanTaggedComments(text: string, options: ScanOptions = {}): TaggedCommentScan {
  const registry = options.registry ?? defaultRegistry;
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const blocks: TaggedCommentBlock[] = [];
  const unknownTags: UnknownTag[] = [];
  let truncated = false;
  let lines: LineIndex | undefined;

  for (const token of lexCSharp(text)) {
    if (token.kind !== 'blockComment') {
      continue;
    }
    const opening = parseOpening(text, token.start, token.end);
    if (!opening) {
      continue;
    }
    lines ??= new LineIndex(text);
    const descriptor = registry.resolve(opening.tag);
    if (!descriptor) {
      unknownTags.push({
        tag: opening.tag,
        tagStartOffset: opening.tagStart,
        tagEndOffset: opening.tagEnd,
        startLine: lines.lineAt(token.start),
      });
      continue;
    }
    if (blocks.length >= maxBlocks) {
      truncated = true;
      break;
    }
    const close = token.terminated ? token.end - 2 : token.end;
    const bodyStart = Math.min(opening.bodyStart, close);
    const end = bodyEnd(text, bodyStart, close);
    const normalized = normalizeBody(text, bodyStart, end, lines);
    blocks.push({
      index: blocks.length,
      language: descriptor.id,
      descriptor,
      mode: descriptor.mode,
      tag: opening.tag,
      startOffset: token.start,
      endOffset: token.end,
      tagStartOffset: opening.tagStart,
      tagEndOffset: opening.tagEnd,
      bodyStartOffset: bodyStart,
      bodyEndOffset: end,
      startLine: lines.lineAt(token.start),
      endLine: lines.lineAt(Math.max(token.start, token.end - 1)),
      terminated: token.terminated,
      rawBody: text.slice(bodyStart, end),
      normalizedBody: normalized.text,
      lineMap: normalized.lines,
    });
  }
  return { blocks, unknownTags, truncated };
}

/** Returns the block whose comment range contains `offset` (inclusive of both delimiters). */
export function findBlockAt(scan: TaggedCommentScan, offset: number): TaggedCommentBlock | undefined {
  const { blocks } = scan;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid];
    if (offset < b.startOffset) {
      hi = mid - 1;
    } else if (offset > b.endOffset) {
      lo = mid + 1;
    } else {
      return b;
    }
  }
  return undefined;
}
