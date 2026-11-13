import type { FileAppTextAnalysis } from './fileAppSignals';

export interface DirectiveTextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parsePackageReference(input: string): { readonly id: string; readonly version: string; readonly value: string } | undefined {
  const value = input.trim();
  const separator = value.indexOf('@');
  if (
    value.length > 512 ||
    separator <= 0 ||
    separator === value.length - 1 ||
    value.indexOf('@', separator + 1) >= 0 ||
    /[\r\n]/.test(value)
  ) {
    return undefined;
  }
  const id = value.slice(0, separator).trim();
  const version = value.slice(separator + 1).trim();
  if (!PACKAGE_ID_RE.test(id) || version.length === 0 || version.includes('#:')) {
    return undefined;
  }
  return { id, version, value: `${id}@${version}` };
}

export function packageDirectiveId(value: string): string | undefined {
  const separator = value.indexOf('@');
  const id = (separator < 0 ? value : value.slice(0, separator)).trim();
  return PACKAGE_ID_RE.test(id) ? id : undefined;
}

export function makeDirectiveInsertion(
  source: string,
  analysis: Pick<FileAppTextAnalysis, 'directives' | 'hasDotnetShebang'>,
  line: string,
): DirectiveTextEdit {
  const newline = source.match(/\r\n|[\r\n\u0085\u2028\u2029]/)?.[0] ?? '\n';
  const bomLength = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let offset = bomLength;
  const lastDirective = analysis.directives.at(-1);
  if (lastDirective) {
    offset = afterLineEnding(source, lastDirective.end);
  } else if (analysis.hasDotnetShebang) {
    const firstLineEnd = findLineEnding(source, bomLength);
    offset = firstLineEnd < 0 ? source.length : afterLineEnding(source, firstLineEnd);
  }
  const needsLeadingNewline =
    offset > bomLength && !isNewline(source.charCodeAt(offset - 1));
  return {
    start: offset,
    end: offset,
    text: `${needsLeadingNewline ? newline : ''}${line}${newline}`,
  };
}

function findLineEnding(source: string, start: number): number {
  for (let i = start; i < source.length; i++) {
    if (isNewline(source.charCodeAt(i))) {
      return i;
    }
  }
  return -1;
}

function afterLineEnding(source: string, offset: number): number {
  if (source.startsWith('\r\n', offset)) {
    return offset + 2;
  }
  return isNewline(source.charCodeAt(offset)) ? offset + 1 : offset;
}

function isNewline(code: number | undefined): boolean {
  return code === 10 || code === 13 || code === 0x85 || code === 0x2028 || code === 0x2029;
}
