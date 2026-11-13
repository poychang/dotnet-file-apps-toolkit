import { parse as parseJson, printParseErrorCode } from 'jsonc-parser/lib/esm/main.js';
import { parseDocument } from 'yaml';
import type { TaggedCommentBlock } from './taggedCommentScanner';

export const MAX_STRUCTURED_DATA_CHARS = 200_000;
const MAX_ALIAS_COUNT = 50;
const MAX_STRUCTURE_NODES = 500;
const MAX_STRUCTURE_DEPTH = 20;
const MAX_ISSUES = 20;

export interface StructuredDataIssue {
  readonly message: string;
  readonly offset: number;
  readonly length: number;
}

export interface StructureNode {
  readonly label: string;
  readonly kind: string;
  readonly children?: readonly StructureNode[];
}

export interface StructuredDataResult {
  readonly issues: readonly StructuredDataIssue[];
  readonly structure?: StructureNode;
}

function issue(message: string, offset: number, length = 1): StructuredDataIssue {
  return { message, offset: Math.max(0, offset), length: Math.max(0, length) };
}

function nodeKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value instanceof Date) {
    return 'date';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return typeof value;
}

function createStructure(value: unknown): StructureNode {
  const seen = new WeakSet<object>();
  let count = 0;

  function visit(item: unknown, label: string, depth: number): StructureNode {
    if (count >= MAX_STRUCTURE_NODES) {
      return { label, kind: 'truncated' };
    }
    count++;
    const kind = nodeKind(item);
    if (depth >= MAX_STRUCTURE_DEPTH) {
      return { label, kind: `${kind} (depth limit)` };
    }
    if (item === null || typeof item !== 'object') {
      return { label, kind };
    }
    if (seen.has(item)) {
      return { label, kind: 'reference' };
    }
    seen.add(item);
    const entries = Array.isArray(item)
      ? item.map((value, index) => [`[${index}]`, value] as const)
      : Object.entries(item);
    const children: StructureNode[] = [];
    for (const [childLabel, childValue] of entries) {
      if (count >= MAX_STRUCTURE_NODES) {
        children.push({ label: '…', kind: 'truncated' });
        break;
      }
      children.push(visit(childValue, childLabel, depth + 1));
    }
    return { label, kind, children };
  }

  return visit(value, 'root', 0);
}

function analyzeJson(source: string): StructuredDataResult {
  const errors: Parameters<typeof parseJson>[1] = [];
  const value: unknown = parseJson(source, errors, {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (errors.length > 0) {
    return {
      issues: errors.slice(0, MAX_ISSUES).map((error) => issue(printParseErrorCode(error.error), error.offset, error.length)),
    };
  }
  return { issues: [], structure: createStructure(value) };
}

function analyzeYaml(source: string): StructuredDataResult {
  try {
    const document = parseDocument(source, { strict: true, uniqueKeys: true, stringKeys: true });
    if (document.errors.length > 0) {
      return {
        issues: document.errors.slice(0, MAX_ISSUES).map((error) => issue(error.message, error.pos[0], error.pos[1] - error.pos[0])),
      };
    }
    return { issues: [], structure: createStructure(document.toJS({ maxAliasCount: MAX_ALIAS_COUNT })) };
  } catch (error) {
    return { issues: [issue(error instanceof Error ? error.message : String(error), 0)] };
  }
}

/** Validates one YAML or JSON tagged comment and returns a bounded, value-free structure outline. */
export function analyzeStructuredBlock(block: TaggedCommentBlock): StructuredDataResult {
  if (block.language !== 'yaml' && block.language !== 'json') {
    return { issues: [] };
  }
  const source = block.normalizedBody;
  if (source.length > MAX_STRUCTURED_DATA_CHARS) {
    return { issues: [issue(`Input exceeds the ${MAX_STRUCTURED_DATA_CHARS}-character validation limit.`, 0, 0)] };
  }
  return block.language === 'json' ? analyzeJson(source) : analyzeYaml(source);
}
