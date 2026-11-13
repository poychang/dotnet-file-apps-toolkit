import * as vscode from 'vscode';
import type { Logger } from '../core/logging';
import { getSettings } from '../core/settings';
import { defaultRegistry } from './embeddedLanguageRegistry';
import { analyzeStructuredBlock, type StructuredDataResult, type StructuredDataIssue } from './structuredData';
import { scanTaggedComments, type TaggedCommentScan } from './taggedCommentScanner';

export const TAGGED_COMMENT_URIS_CONTEXT_KEY = 'dotnetFileApps.taggedCommentUris';
/** Larger documents are not scanned. */
export const MAX_SCAN_CHARS = 5_000_000;
const EMPTY_SCAN: TaggedCommentScan = { blocks: [], unknownTags: [], truncated: false };
const EMPTY_STRUCTURED_DATA: ReadonlyMap<number, StructuredDataResult> = new Map();
const CHANGE_DELAY_MS = 200;

export function isCSharpDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'csharp' || /\.cs$/i.test(document.uri.path);
}

/**
 * Scans open C# documents for explicitly tagged comments, caches the result per document version and
 * publishes `dotnetFileApps.taggedCommentUris` so the preview action only appears where it applies.
 */
export class TaggedCommentService implements vscode.Disposable {
  private readonly cache = new Map<string, { version: number; scan: TaggedCommentScan }>();
  private readonly structuredDataCache = new Map<
    string,
    { version: number; results: ReadonlyMap<number, StructuredDataResult> }
  >();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly withBlocks = new Set<string>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('dotnetFileApps.taggedComments');
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TextDocument>();
  private readonly disposables: vscode.Disposable[] = [];
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPublished = '';

  /** Fires after a document's scan was refreshed (debounced while typing) or settings changed. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly logger: Logger) {
    this.disposables.push(
      this.diagnostics,
      this.changeEmitter,
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) {
          this.schedule(e.document, CHANGE_DELAY_MS);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.forget(d)),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dotnetFileAppsToolkit.enabled') || e.affectsConfiguration('dotnetFileAppsToolkit.comments')) {
          this.refreshAll();
        }
      }),
    );
    this.refreshAll();
  }

  isEnabled(uri?: vscode.Uri): boolean {
    const settings = getSettings(uri);
    return settings.enabled && settings.comments.enabled;
  }

  /** Current scan of a document; empty when tagged comments are disabled or the document is not C#. */
  getScan(document: vscode.TextDocument): TaggedCommentScan {
    if (!isCSharpDocument(document) || !this.isEnabled(document.uri)) {
      return EMPTY_SCAN;
    }
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === document.version) {
      return cached.scan;
    }
    const text = document.getText();
    let scan = EMPTY_SCAN;
    if (text.length <= MAX_SCAN_CHARS) {
      try {
        scan = scanTaggedComments(text);
      } catch (err) {
        this.logger.warn(`Tagged comment scan failed for ${document.uri.toString(true)}: ${err}`);
      }
    }
    if (!document.isClosed) {
      this.cache.set(key, { version: document.version, scan });
    }
    return scan;
  }

  hasTaggedComments(uri: vscode.Uri): boolean {
    return this.withBlocks.has(uri.toString());
  }

  /** Validates YAML and JSON tagged blocks only when the opt-in setting is enabled. */
  getStructuredData(document: vscode.TextDocument): ReadonlyMap<number, StructuredDataResult> {
    if (!getSettings(document.uri).comments.validationEnabled) {
      return EMPTY_STRUCTURED_DATA;
    }
    const key = document.uri.toString();
    const cached = this.structuredDataCache.get(key);
    if (cached?.version === document.version) {
      return cached.results;
    }
    const results = new Map<number, StructuredDataResult>();
    for (const block of this.getScan(document).blocks) {
      if (block.language === 'yaml' || block.language === 'json') {
        results.set(block.index, analyzeStructuredBlock(block));
      }
    }
    this.structuredDataCache.set(key, { version: document.version, results });
    return results;
  }

  refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) {
      this.schedule(doc, 0);
    }
  }

  private schedule(document: vscode.TextDocument, delayMs: number): void {
    if (!isCSharpDocument(document)) {
      return;
    }
    const key = document.uri.toString();
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        if (!document.isClosed) {
          this.refresh(document);
        }
      }, delayMs),
    );
  }

  private refresh(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const scan = this.getScan(document);
    if (scan.blocks.length > 0) {
      this.withBlocks.add(key);
    } else {
      this.withBlocks.delete(key);
    }
    this.updateDiagnostics(document, scan);
    this.publishSoon();
    this.changeEmitter.fire(document);
  }

  private updateDiagnostics(document: vscode.TextDocument, scan: TaggedCommentScan): void {
    const settings = getSettings(document.uri);
    const diagnostics: vscode.Diagnostic[] = [];
    if (settings.comments.unknownTagDiagnostic) {
      const supported = defaultRegistry.allTags().join(', ');
      diagnostics.push(
        ...scan.unknownTags.map((u) => {
          const d = new vscode.Diagnostic(
            new vscode.Range(document.positionAt(u.tagStartOffset), document.positionAt(u.tagEndOffset)),
            vscode.l10n.t(
              'Unknown comment language tag "{0}". This comment is treated as an ordinary comment. Supported tags: {1}.',
              u.tag,
              supported,
            ),
            vscode.DiagnosticSeverity.Information,
          );
          d.source = '.NET File Apps';
          d.code = 'unknown-comment-tag';
          return d;
        }),
      );
    }
    if (settings.comments.validationEnabled) {
      const structuredData = this.getStructuredData(document);
      for (const block of scan.blocks) {
        for (const validationIssue of structuredData.get(block.index)?.issues ?? []) {
          diagnostics.push(this.validationDiagnostic(document, block.lineMap, block.bodyStartOffset, validationIssue, block.descriptor.displayName));
        }
      }
    }
    if (diagnostics.length === 0) {
      this.diagnostics.delete(document.uri);
      return;
    }
    this.diagnostics.set(document.uri, diagnostics);
  }

  private validationDiagnostic(
    document: vscode.TextDocument,
    lines: TaggedCommentScan['blocks'][number]['lineMap'],
    bodyStartOffset: number,
    validationIssue: StructuredDataIssue,
    language: string,
  ): vscode.Diagnostic {
    const sourceLine = lines.length > 0 ? Math.min(lines.length - 1, lineAtOffset(lines, validationIssue.offset)) : -1;
    const line = sourceLine >= 0 ? lines[sourceLine] : undefined;
    const column = line ? Math.min(validationIssue.offset - offsetAtLine(lines, sourceLine), line.text.length) : 0;
    const start = line ? line.sourceOffset + Math.max(0, column) : bodyStartOffset;
    const end = line ? line.sourceOffset + Math.min(line.text.length, Math.max(column + validationIssue.length, column + 1)) : start;
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(start), document.positionAt(end)),
      vscode.l10n.t('Invalid {0}: {1}', language, validationIssue.message),
      vscode.DiagnosticSeverity.Error,
    );
    diagnostic.source = '.NET File Apps';
    diagnostic.code = language === 'YAML' ? 'yaml-validation-error' : 'json-validation-error';
    return diagnostic;
  }

  private forget(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const t = this.pending.get(key);
    if (t) {
      clearTimeout(t);
      this.pending.delete(key);
    }
    this.cache.delete(key);
    this.structuredDataCache.delete(key);
    this.diagnostics.delete(document.uri);
    if (this.withBlocks.delete(key)) {
      this.publishSoon();
    }
  }

  private publishSoon(): void {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
    }
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      const uris = [...this.withBlocks].sort();
      const serialized = JSON.stringify(uris);
      if (serialized !== this.lastPublished) {
        this.lastPublished = serialized;
        void vscode.commands.executeCommand('setContext', TAGGED_COMMENT_URIS_CONTEXT_KEY, uris);
      }
    }, 50);
  }

  dispose(): void {
    this.pending.forEach((t) => clearTimeout(t));
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
    }
    this.disposables.forEach((d) => d.dispose());
    this.structuredDataCache.clear();
  }
}

function lineAtOffset(lines: TaggedCommentScan['blocks'][number]['lineMap'], offset: number): number {
  let remaining = Math.max(0, offset);
  for (let i = 0; i < lines.length; i++) {
    if (remaining <= lines[i].text.length) {
      return i;
    }
    remaining -= lines[i].text.length + 1;
  }
  return Math.max(0, lines.length - 1);
}

function offsetAtLine(lines: TaggedCommentScan['blocks'][number]['lineMap'], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i++) {
    offset += lines[i].text.length + 1;
  }
  return offset;
}
