import * as vscode from 'vscode';
import type { Logger } from '../core/logging';
import { getSettings } from '../core/settings';
import { defaultRegistry } from './embeddedLanguageRegistry';
import { scanTaggedComments, type TaggedCommentScan } from './taggedCommentScanner';

export const TAGGED_COMMENT_URIS_CONTEXT_KEY = 'dotnetFileApps.taggedCommentUris';
/** Larger documents are not scanned. */
export const MAX_SCAN_CHARS = 5_000_000;
const EMPTY_SCAN: TaggedCommentScan = { blocks: [], unknownTags: [], truncated: false };
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
    if (scan.unknownTags.length === 0 || !getSettings(document.uri).comments.unknownTagDiagnostic) {
      this.diagnostics.delete(document.uri);
      return;
    }
    const supported = defaultRegistry.allTags().join(', ');
    this.diagnostics.set(
      document.uri,
      scan.unknownTags.map((u) => {
        const d = new vscode.Diagnostic(
          new vscode.Range(document.positionAt(u.tagStartOffset), document.positionAt(u.tagEndOffset)),
          vscode.l10n.t('Unknown comment language tag "{0}". This comment is treated as an ordinary comment. Supported tags: {1}.', u.tag, supported),
          vscode.DiagnosticSeverity.Information,
        );
        d.source = '.NET File Apps';
        d.code = 'unknown-comment-tag';
        return d;
      }),
    );
  }

  private forget(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const t = this.pending.get(key);
    if (t) {
      clearTimeout(t);
      this.pending.delete(key);
    }
    this.cache.delete(key);
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
  }
}
