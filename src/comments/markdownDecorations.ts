import * as vscode from 'vscode';
import { getSettings } from '../core/settings';
import { markdownDecorationRanges, type MarkdownDecorationKind } from './markdownSyntax';
import { isCSharpDocument, type TaggedCommentService } from './taggedCommentService';

/** Upper bound of decorated ranges per editor and kind. */
const MAX_RANGES_PER_KIND = 5000;

const KINDS: readonly MarkdownDecorationKind[] = ['bold', 'italic', 'code', 'link'];

/**
 * Adds emphasis to `/*markdown` comment bodies in the native editor: headings, bold and list/quote markers
 * in bold, italics, inline code background and underlined links. Only font style, background and
 * underline are used so the theme's (or the injected grammar's) colors stay intact and no source
 * characters are hidden. In `decorations` mode the syntax highlight controller additionally paints
 * `.md`-style colors over the body; this layer stays the emphasis-only fallback for the other strategies.
 */
export class MarkdownDecorationController implements vscode.Disposable {
  private readonly types: Record<MarkdownDecorationKind, vscode.TextEditorDecorationType>;
  private readonly disposables: vscode.Disposable[] = [];
  /** Last applied ranges per document, for diagnostics and tests. */
  readonly applied = new Map<string, Record<MarkdownDecorationKind, vscode.Range[]>>();

  constructor(private readonly service: TaggedCommentService) {
    this.types = {
      bold: vscode.window.createTextEditorDecorationType({ fontWeight: 'bold' }),
      italic: vscode.window.createTextEditorDecorationType({ fontStyle: 'italic' }),
      code: vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('textCodeBlock.background'),
        borderRadius: '3px',
      }),
      link: vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' }),
    };
    this.disposables.push(
      ...Object.values(this.types),
      service.onDidChange((doc) => this.updateDocument(doc)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.updateEditor(e))),
      vscode.workspace.onDidCloseTextDocument((doc) => this.applied.delete(doc.uri.toString())),
    );
    vscode.window.visibleTextEditors.forEach((e) => this.updateEditor(e));
  }

  private isActive(uri: vscode.Uri): boolean {
    const settings = getSettings(uri);
    return (
      this.service.isEnabled(uri) && settings.comments.highlightEnabled && settings.comments.highlightStrategy !== 'off'
    );
  }

  private updateDocument(document: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) {
        this.updateEditor(editor);
      }
    }
  }

  private updateEditor(editor: vscode.TextEditor): void {
    const document = editor.document;
    if (!isCSharpDocument(document)) {
      return;
    }
    const ranges: Record<MarkdownDecorationKind, vscode.Range[]> = { bold: [], italic: [], code: [], link: [] };
    if (this.isActive(document.uri)) {
      for (const block of this.service.getScan(document).blocks) {
        if (block.language !== 'markdown') {
          continue;
        }
        for (const r of markdownDecorationRanges(block.lineMap)) {
          const list = ranges[r.kind];
          if (list.length < MAX_RANGES_PER_KIND) {
            list.push(new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)));
          }
        }
      }
    }
    for (const kind of KINDS) {
      editor.setDecorations(this.types[kind], ranges[kind]);
    }
    this.applied.set(document.uri.toString(), ranges);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.applied.clear();
  }
}
