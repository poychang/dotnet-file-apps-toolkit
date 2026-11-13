import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { UserFacingError } from '../core/errors';
import type { Logger } from '../core/logging';
import { getSettings } from '../core/settings';
import type { CodeHighlighter } from './codeHighlighter';
import { defaultRegistry } from './embeddedLanguageRegistry';
import { createMarkdownRenderer, escapeHtml } from './markdownRenderer';
import { parsePreviewMessage, renderPreview, type PreviewLabels, type PreviewMessage, type RenderedBlock } from './previewHtml';
import { findBlockAt } from './taggedCommentScanner';
import { isCSharpDocument, type TaggedCommentService } from './taggedCommentService';

export const PREVIEW_VIEW_TYPE = 'dotnetFileApps.taggedCommentPreview';
const UPDATE_DELAY_MS = 150;
const FOCUS_DELAY_MS = 100;

function labels(): PreviewLabels {
  return {
    lines: (start, end) => (start === end ? vscode.l10n.t('Line {0}', start) : vscode.l10n.t('Lines {0}–{1}', start, end)),
    goToSource: vscode.l10n.t('Go to the comment in the source file'),
    copy: vscode.l10n.t('Copy'),
    copyTitle: vscode.l10n.t('Copy the exact comment body to the clipboard'),
    unterminated: vscode.l10n.t('Missing closing */'),
    empty: vscode.l10n.t('This file has no tagged comments.'),
    emptyHint: '/*markdown\n# Title\n\nDescribe the app here.\n*/\n\n/*yaml\nkey: value\n*/',
    emptyBody: vscode.l10n.t('(empty)'),
    renderFailed: (reason) => vscode.l10n.t('This block could not be rendered ({0}). Showing plain text.', reason),
    tooLarge: vscode.l10n.t('This block is too large to highlight. Showing plain text.'),
    noHighlighter: vscode.l10n.t('Syntax highlighting is unavailable for this block. Showing plain text.'),
    truncated: (shown) => vscode.l10n.t('Only the first {0} tagged comments are shown.', shown),
    structurePreview: vscode.l10n.t('Structure preview'),
    validationIssues: (count) => vscode.l10n.t('Validation found {0} issue(s).', count),
  };
}

export interface PreviewSnapshot {
  readonly version: number;
  readonly html: string;
  readonly blocks: readonly RenderedBlock[];
}

/** One preview panel bound to one source document. */
export class TaggedCommentPreview implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private focusTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFocused: number | undefined;
  private disposed = false;
  private sourceColumn: vscode.ViewColumn | undefined;
  snapshot: PreviewSnapshot | undefined;

  constructor(
    readonly uri: vscode.Uri,
    readonly panel: vscode.WebviewPanel,
    private readonly manager: TaggedCommentPreviewManager,
    private readonly onDispose: () => void,
  ) {
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m) => this.handleMessage(m)),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.scheduleUpdate(0);
        }
      }),
    );
  }

  get document(): vscode.TextDocument | undefined {
    const key = this.uri.toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }

  rememberSourceColumn(column: vscode.ViewColumn | undefined): void {
    if (column !== undefined) {
      this.sourceColumn = column;
    }
  }

  scheduleUpdate(delayMs = UPDATE_DELAY_MS): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.update();
    }, delayMs);
  }

  /** Re-renders from the current document text and pushes the result to the webview. */
  async update(): Promise<PreviewSnapshot | undefined> {
    const document = this.document;
    if (this.disposed || !document) {
      return this.snapshot;
    }
    const snapshot = await this.manager.render(document);
    if (this.disposed) {
      return undefined;
    }
    this.snapshot = snapshot;
    await this.panel.webview.postMessage({ type: 'update', html: snapshot.html });
    return snapshot;
  }

  scheduleFocus(offset: number): void {
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
    }
    this.focusTimer = setTimeout(() => {
      this.focusTimer = undefined;
      const document = this.document;
      if (!document || this.disposed || !this.panel.visible) {
        return;
      }
      const block = findBlockAt(this.manager.service.getScan(document), offset);
      if (block && block.index !== this.lastFocused) {
        this.lastFocused = block.index;
        void this.panel.webview.postMessage({ type: 'focus', block: block.index });
      }
    }, FOCUS_DELAY_MS);
  }

  /** Handles a message from the webview. Exposed for tests; input is validated. */
  async handleMessage(raw: unknown): Promise<void> {
    const message = parsePreviewMessage(raw);
    if (!message) {
      this.manager.logger.debug(`Ignored unexpected preview message: ${JSON.stringify(raw)?.slice(0, 200)}`);
      return;
    }
    switch (message.type) {
      case 'ready':
        if (this.snapshot) {
          await this.panel.webview.postMessage({ type: 'update', html: this.snapshot.html });
        }
        this.scheduleUpdate(0);
        return;
      case 'reveal':
        await this.reveal(message);
        return;
      case 'copy':
        await this.copy(message.block);
        return;
    }
  }

  private async reveal(message: Extract<PreviewMessage, { type: 'reveal' }>): Promise<void> {
    const document = this.document ?? (await vscode.workspace.openTextDocument(this.uri));
    const block = this.manager.service.getScan(document).blocks[message.block];
    if (!block) {
      return;
    }
    const line = message.line !== undefined ? block.lineMap[message.line] : undefined;
    const position = document.positionAt(line ? line.sourceOffset : block.bodyStartOffset);
    const visible = vscode.window.visibleTextEditors.find((e) => e.document === document);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: visible?.viewColumn ?? this.sourceColumn ?? vscode.ViewColumn.One,
      preserveFocus: false,
      selection: new vscode.Range(position, position),
    });
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async copy(index: number): Promise<void> {
    const document = this.document ?? (await vscode.workspace.openTextDocument(this.uri));
    const block = this.manager.service.getScan(document).blocks[index];
    if (!block) {
      return;
    }
    await vscode.env.clipboard.writeText(block.rawBody);
    vscode.window.setStatusBarMessage(vscode.l10n.t('Copied the {0} comment body to the clipboard.', block.descriptor.displayName), 3000);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    if (this.focusTimer) {
      clearTimeout(this.focusTimer);
    }
    this.onDispose();
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}

/**
 * Opens and maintains tagged-comment preview panels (one per source document). Rendering happens in the
 * extension host; the webview only receives sanitized HTML and reports clicks.
 */
export class TaggedCommentPreviewManager implements vscode.Disposable {
  private readonly previews = new Map<string, TaggedCommentPreview>();
  private readonly autoOpened = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    readonly service: TaggedCommentService,
    readonly logger: Logger,
    private readonly getHighlighter: () => Promise<CodeHighlighter | undefined>,
  ) {
    this.disposables.push(
      service.onDidChange((doc) => this.previews.get(doc.uri.toString())?.scheduleUpdate()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const preview = this.previews.get(e.textEditor.document.uri.toString());
        if (preview && e.selections.length > 0) {
          preview.rememberSourceColumn(e.textEditor.viewColumn);
          preview.scheduleFocus(e.textEditor.document.offsetAt(e.selections[0].active));
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((e) => this.maybeAutoOpen(e)),
      service.onDidChange((doc) => {
        if (vscode.window.activeTextEditor?.document === doc) {
          this.maybeAutoOpen(vscode.window.activeTextEditor);
        }
      }),
    );
    this.maybeAutoOpen(vscode.window.activeTextEditor);
  }

  get(uri: vscode.Uri): TaggedCommentPreview | undefined {
    return this.previews.get(uri.toString());
  }

  /** Opens (or reveals) the preview for a C# document. */
  async show(uri: vscode.Uri, options: { preserveFocus?: boolean } = {}): Promise<TaggedCommentPreview> {
    const document = await vscode.workspace.openTextDocument(uri);
    if (!isCSharpDocument(document)) {
      throw new UserFacingError(vscode.l10n.t('Tagged comment preview is only available for C# (.cs) files.'), [], 'info');
    }
    if (!this.service.isEnabled(uri)) {
      throw new UserFacingError(
        vscode.l10n.t('Tagged comments are disabled. Enable "dotnetFileAppsToolkit.comments.enabled" to preview them.'),
        [],
        'info',
      );
    }
    const key = uri.toString();
    const sourceColumn = vscode.window.visibleTextEditors.find((e) => e.document === document)?.viewColumn;
    const existing = this.previews.get(key);
    if (existing) {
      existing.rememberSourceColumn(sourceColumn);
      existing.panel.reveal(undefined, options.preserveFocus);
      await existing.update();
      return existing;
    }

    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      PREVIEW_VIEW_TYPE,
      vscode.l10n.t('Tagged Comments: {0}', path.posix.basename(uri.path)),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: options.preserveFocus ?? false },
      { enableScripts: true, enableCommandUris: false, enableFindWidget: true, localResourceRoots: [media] },
    );
    const preview = new TaggedCommentPreview(uri, panel, this, () => this.previews.delete(key));
    preview.rememberSourceColumn(sourceColumn);
    this.previews.set(key, preview);

    const snapshot = await this.render(document);
    preview.snapshot = snapshot;
    panel.webview.html = await this.pageHtml(panel.webview, media, snapshot.html);
    return preview;
  }

  /** Renders the current tagged comments of a document to preview HTML. */
  async render(document: vscode.TextDocument): Promise<PreviewSnapshot> {
    const version = document.version;
    const highlighter = await this.getHighlighter();
    const markdown = createMarkdownRenderer({
      allowRemoteImages: vscode.workspace.isTrusted,
      highlight: (code, lang) => {
        const language = defaultRegistry.resolve(lang)?.previewLanguage ?? lang.toLowerCase();
        return highlighter?.highlightToHtml(code, language);
      },
    });
    const { html, blocks } = renderPreview(this.service.getScan(document), {
      labels: labels(),
      markdown,
      highlighter,
      structuredData: this.service.getStructuredData(document),
    });
    return { version, html, blocks };
  }

  private async pageHtml(webview: vscode.Webview, media: vscode.Uri, content: string): Promise<string> {
    const nonce = crypto.randomBytes(16).toString('base64');
    const highlighter = await this.getHighlighter();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'preview.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'preview.js'));
    const images = vscode.workspace.isTrusted ? ` https:` : '';
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}${images}`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<style nonce="${nonce}">${highlighter?.css ?? ''}</style>
</head>
<body>
<main id="content">${content}</main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  private maybeAutoOpen(editor: vscode.TextEditor | undefined): void {
    if (!editor || !isCSharpDocument(editor.document)) {
      return;
    }
    const uri = editor.document.uri;
    const key = uri.toString();
    if (this.autoOpened.has(key) || this.previews.has(key) || !getSettings(uri).comments.previewOnOpen) {
      return;
    }
    if (this.service.getScan(editor.document).blocks.length === 0) {
      return;
    }
    this.autoOpened.add(key);
    this.show(uri, { preserveFocus: true }).catch((err) => this.logger.warn(`Could not open the tagged comment preview: ${err}`));
  }

  dispose(): void {
    [...this.previews.values()].forEach((p) => p.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
