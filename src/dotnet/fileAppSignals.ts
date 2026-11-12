import { lexCSharp, maskNonCode, type CSharpToken } from '../csharp/csharpLexer';

export interface FileAppDirective {
  /** Directive name without the `#:` prefix, e.g. `package`. */
  readonly name: string;
  /** Text after the directive name. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export interface FileAppTextAnalysis {
  /** First line is a shebang that launches `dotnet`. */
  readonly hasDotnetShebang: boolean;
  /** `#:` directives located in the leading trivia of the file. */
  readonly directives: readonly FileAppDirective[];
  /** Heuristic: the file contains top-level statements (executable code outside type declarations). */
  readonly hasTopLevelStatements: boolean;
}

export const KNOWN_DIRECTIVES = ['sdk', 'package', 'project', 'property', 'include'] as const;

export type DetectionMode = 'strict' | 'standalone' | 'manual';
export type FileAppOverride = 'enabled' | 'disabled';

export type FileAppReason =
  | 'override-enabled'
  | 'override-disabled'
  | 'directives'
  | 'shebang'
  | 'top-level-statements'
  | 'inside-project'
  | 'manual-mode'
  | 'no-signal';

export interface FileAppDecision {
  readonly isFileApp: boolean;
  readonly reason: FileAppReason;
  /** Strong (directive/shebang) or candidate (top-level code outside a project) signal, regardless of mode. */
  readonly signal: 'strong' | 'candidate' | 'none';
}

/**
 * Applies the detection policy. `inProjectCone` is only consulted for candidate files and may be
 * computed lazily by the caller.
 */
export function decideFileApp(
  mode: DetectionMode,
  override: FileAppOverride | undefined,
  analysis: FileAppTextAnalysis,
  inProjectCone: boolean,
): FileAppDecision {
  const strong = analysis.directives.length > 0 || analysis.hasDotnetShebang;
  const candidate = !strong && analysis.hasTopLevelStatements && !inProjectCone;
  const signal = strong ? 'strong' : candidate ? 'candidate' : 'none';
  if (override === 'disabled') {
    return { isFileApp: false, reason: 'override-disabled', signal };
  }
  if (override === 'enabled') {
    return { isFileApp: true, reason: 'override-enabled', signal };
  }
  if (mode === 'manual') {
    return { isFileApp: false, reason: 'manual-mode', signal };
  }
  if (strong) {
    return { isFileApp: true, reason: analysis.directives.length > 0 ? 'directives' : 'shebang', signal };
  }
  if (mode === 'standalone' && candidate) {
    return { isFileApp: true, reason: 'top-level-statements', signal };
  }
  if (analysis.hasTopLevelStatements && inProjectCone) {
    return { isFileApp: false, reason: 'inside-project', signal };
  }
  return { isFileApp: false, reason: 'no-signal', signal };
}

/** True when the (expensive) project-cone lookup can change the decision. */
export function needsProjectConeCheck(mode: DetectionMode, analysis: FileAppTextAnalysis): boolean {
  return mode === 'standalone' && analysis.directives.length === 0 && !analysis.hasDotnetShebang && analysis.hasTopLevelStatements;
}

const DIRECTIVE_RE = /^#:([A-Za-z][\w-]*)(?:\s+(.*))?$/;

export function analyzeFileAppText(text: string, tokens: readonly CSharpToken[] = lexCSharp(text)): FileAppTextAnalysis {
  const leading = analyzeLeadingTrivia(text, tokens);
  return {
    ...leading,
    hasTopLevelStatements: hasTopLevelStatements(maskNonCode(text, tokens)),
  };
}

function analyzeLeadingTrivia(text: string, tokens: readonly CSharpToken[]) {
  const directives: FileAppDirective[] = [];
  let hasDotnetShebang = false;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (const t of tokens) {
    if (text.slice(pos, t.start).trim().length > 0) {
      break; // code reached
    }
    pos = t.end;
    if (t.kind !== 'directive') {
      if (t.kind === 'lineComment' || t.kind === 'blockComment') {
        continue;
      }
      break;
    }
    const line = text.slice(t.start, t.end).trimEnd();
    if (line.startsWith('#!')) {
      if (t.start <= 1 && /\bdotnet\b/.test(line)) {
        hasDotnetShebang = true;
      }
      continue;
    }
    const m = DIRECTIVE_RE.exec(line);
    if (m) {
      directives.push({ name: m[1].toLowerCase(), value: (m[2] ?? '').trim(), start: t.start, end: t.end });
    }
    // Other preprocessor directives (#nullable, #region, ...) are trivia here.
  }
  return { hasDotnetShebang, directives };
}

const TYPE_DECLARATION_RE =
  /^(?:(?:public|private|protected|internal|static|sealed|abstract|partial|file|readonly|ref|unsafe|new)\s+)*(?:class|struct|record|interface|enum|delegate)\b/;
const USING_DIRECTIVE_RE = /^(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_@][\w@]*\s*=\s*)?[A-Za-z_@][\w@.:<>,\s?[\]]*$/;

/**
 * Heuristically determines whether masked C# code contains top-level statements by looking at
 * brace-depth-0 chunks that are neither using/namespace/extern-alias directives nor type declarations.
 */
export function hasTopLevelStatements(maskedCode: string): boolean {
  let depth = 0;
  let chunkStart = 0;
  const n = maskedCode.length;
  for (let i = 0; i < n; i++) {
    const c = maskedCode[i];
    if (c === '{') {
      if (depth === 0) {
        const verdict = classifyChunk(maskedCode.slice(chunkStart, i), true);
        if (verdict === 'statement') {
          return true;
        }
        if (verdict === 'stop') {
          return false;
        }
      }
      depth++;
    } else if (c === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        chunkStart = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      const verdict = classifyChunk(maskedCode.slice(chunkStart, i), false);
      if (verdict === 'statement') {
        return true;
      }
      if (verdict === 'stop') {
        return false;
      }
      chunkStart = i + 1;
    }
  }
  return false;
}

type ChunkVerdict = 'statement' | 'declaration' | 'empty' | 'stop';

function classifyChunk(raw: string, opensBlock: boolean): ChunkVerdict {
  let chunk = raw.replace(/\s+/g, ' ').trim();
  // Strip leading attribute lists such as [assembly: Foo] or [Obsolete].
  while (chunk.startsWith('[')) {
    const close = chunk.indexOf(']');
    if (close < 0) {
      break;
    }
    chunk = chunk.slice(close + 1).trim();
  }
  if (chunk.length === 0) {
    return 'empty';
  }
  if (/^namespace\b/.test(chunk)) {
    // Top-level statements must precede namespace declarations; a file-scoped namespace ends the search.
    return opensBlock ? 'declaration' : 'stop';
  }
  if (/^extern\s+alias\b/.test(chunk)) {
    return 'declaration';
  }
  if (!opensBlock && USING_DIRECTIVE_RE.test(chunk) && !/^(?:global\s+)?using\s+(?:var|await)\b/.test(chunk)) {
    return 'declaration';
  }
  if (TYPE_DECLARATION_RE.test(chunk)) {
    return 'declaration';
  }
  return 'statement';
}
