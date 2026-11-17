import * as vscode from 'vscode';
import type { Logger } from '../core/logging';
import { getSettings } from '../core/settings';
import {
  FONT_BOLD,
  FONT_ITALIC,
  FONT_STRIKETHROUGH,
  FONT_UNDERLINE,
  type CodeHighlighter,
  type StyledToken,
  type TokenStyle,
} from './codeHighlighter';
import { jsonBracketPairTokens } from './jsonBracketPairs';
import { mapTokensToSource, overlayTokenStyles, type SourceStyledSpan } from './syntaxGrammarAdapter';
import { isCSharpDocument, type TaggedCommentService } from './taggedCommentService';

/** How tagged code comments are colored in a C# editor. */
export type SyntaxHighlightMode = 'off' | 'injection' | 'decorations';

/** Upper bound of decorated ranges per editor. */
export const MAX_SPANS_PER_EDITOR = 20_000;
const TOKEN_CACHE_SIZE = 200;
const LATE_PROVIDER_RECHECK_MS = 5000;

/** C# extensions whose language server paints `comment` semantic tokens over TextMate colors. */
const KNOWN_CSHARP_EXTENSIONS = ['ms-dotnettools.csharp', 'ms-dotnettools.csdevkit', 'muhammad-sammy.csharp'];

export interface AppliedSyntaxRange {
  readonly range: vscode.Range;
  readonly style: TokenStyle;
}

export interface AppliedSyntaxHighlight {
  readonly mode: SyntaxHighlightMode;
  readonly ranges: readonly AppliedSyntaxRange[];
}

function decorationOptions(style: TokenStyle): vscode.DecorationRenderOptions {
  const options: vscode.DecorationRenderOptions = {
    // The theme-specific colors below override this one; it only covers a theme without its own color.
    color: style.themeColor
      ? new vscode.ThemeColor(style.themeColor)
      : style.foreground
        ? new vscode.ThemeColor('editor.foreground')
        : undefined,
    light: style.light ? { color: style.light } : undefined,
    dark: style.dark ? { color: style.dark } : undefined,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  };
  if (style.fontStyle & FONT_ITALIC) {
    options.fontStyle = 'italic';
  }
  if (style.fontStyle & FONT_BOLD) {
    options.fontWeight = 'bold';
  }
  const textDecoration = [
    style.fontStyle & FONT_UNDERLINE ? 'underline' : '',
    style.fontStyle & FONT_STRIKETHROUGH ? 'line-through' : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (textDecoration) {
    options.textDecoration = textDecoration;
  }
  return options;
}

function isHighContrast(kind: vscode.ColorThemeKind): boolean {
  return kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight;
}

/**
 * Colors the bodies of tagged comments (`/*yaml`, `/*json`, `/*markdown`, ...) with editor decorations
 * when the static TextMate injection grammar is not enough. Semantic highlighting from a C# language
 * server paints `comment` tokens over TextMate scopes, so in `auto` mode the bundled highlighter's
 * Light+/Dark+ colors are applied as decorations whenever a semantic tokens provider for C# is (or will
 * be) present. Markdown has no injection grammar and is colored like a `.md` file: headings, emphasis,
 * code, links, lists and quotes get their Light+/Dark+ colors and plain text is painted with the editor
 * foreground instead of the comment color. Only tagged body ranges are decorated; C# code and ordinary
 * comments are never touched.
 */
export class SyntaxHighlightController implements vscode.Disposable {
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();
  private readonly editorKeys = new WeakMap<vscode.TextEditor, ReadonlySet<string>>();
  private readonly generations = new WeakMap<vscode.TextEditor, number>();
  private readonly tokenCache = new Map<string, StyledToken[][] | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private recheckTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Last applied mode and ranges per document, for diagnostics and tests. */
  readonly applied = new Map<string, AppliedSyntaxHighlight>();

  constructor(
    private readonly service: TaggedCommentService,
    private readonly getHighlighter: () => Promise<CodeHighlighter | undefined>,
    private readonly logger: Logger,
  ) {
    this.disposables.push(
      service.onDidChange((doc) => this.updateDocument(doc)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => this.update(e))),
      vscode.window.onDidChangeActiveColorTheme(() => this.refresh()),
      vscode.extensions.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('editor.semanticHighlighting') || e.affectsConfiguration('editor.bracketPairColorization.enabled')) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.applied.delete(doc.uri.toString())),
    );
    this.refresh();
  }

  /** Re-resolves the mode and re-applies decorations in all visible editors. */
  refresh(): void {
    vscode.window.visibleTextEditors.forEach((e) => this.update(e));
  }

  /** Effective mode for a document, resolving `auto` against the current editor environment. */
  async resolveMode(document: vscode.TextDocument): Promise<SyntaxHighlightMode> {
    const settings = getSettings(document.uri);
    if (!this.service.isEnabled(document.uri) || !settings.comments.highlightEnabled) {
      return 'off';
    }
    if (settings.comments.highlightStrategy !== 'auto') {
      return settings.comments.highlightStrategy;
    }
    // High contrast themes keep their own colors; the fallback palette is Light+/Dark+ only.
    if (isHighContrast(vscode.window.activeColorTheme.kind)) {
      return 'injection';
    }
    if (vscode.workspace.getConfiguration('editor', document).get('semanticHighlighting.enabled') === false) {
      return 'injection';
    }
    // A known C# extension activates on C# files; decorate right away instead of flashing injected colors.
    if (KNOWN_CSHARP_EXTENSIONS.some((id) => vscode.extensions.getExtension(id))) {
      return 'decorations';
    }
    try {
      const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>(
        'vscode.provideDocumentSemanticTokensLegend',
        document.uri,
      );
      if (legend) {
        return 'decorations';
      }
    } catch (err) {
      this.logger.debug(`Semantic tokens legend lookup failed: ${err}`);
    }
    return 'injection';
  }

  private updateDocument(document: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) {
        this.update(editor);
      }
    }
  }

  private update(editor: vscode.TextEditor): void {
    if (!isCSharpDocument(editor.document)) {
      return;
    }
    const generation = (this.generations.get(editor) ?? 0) + 1;
    this.generations.set(editor, generation);
    this.updateAsync(editor, generation).catch((err) => this.logger.warn(`Tagged comment highlighting failed: ${err}`));
  }

  private async updateAsync(editor: vscode.TextEditor, generation: number): Promise<void> {
    const document = editor.document;
    const mode = await this.resolveMode(document);
    const blocks = this.service.getScan(document).blocks.filter((b) => b.descriptor.previewLanguage);
    const highlighter = mode === 'decorations' && blocks.length > 0 ? await this.getHighlighter() : undefined;
    if (this.disposed || this.generations.get(editor) !== generation || document.isClosed) {
      return;
    }
    // Rescan after the awaits so offsets match the current document version.
    const spans: SourceStyledSpan[] = [];
    if (mode !== 'off') {
      const colorJsonBrackets = vscode.workspace
        .getConfiguration('editor', document)
        .get<boolean>('bracketPairColorization.enabled', true);
      for (const block of this.service.getScan(document).blocks) {
        const language = block.descriptor.previewLanguage;
        const jsonTokens = block.language === 'json' ? jsonBracketPairTokens(block.lineMap, colorJsonBrackets) : undefined;
        if (highlighter && language) {
          const paintDefault = block.mode === 'document' || block.language === 'json';
          let lines = this.tokenize(highlighter, block.normalizedBody, language, paintDefault);
          if (lines && jsonTokens) {
            lines = overlayTokenStyles(lines, jsonTokens);
          }
          if (lines) {
            spans.push(...mapTokensToSource(block.lineMap, lines, MAX_SPANS_PER_EDITOR - spans.length));
          }
        } else if (jsonTokens) {
          spans.push(...mapTokensToSource(block.lineMap, jsonTokens, MAX_SPANS_PER_EDITOR - spans.length));
        }
        if (spans.length >= MAX_SPANS_PER_EDITOR) {
          break;
        }
      }
    }
    this.apply(editor, mode, spans);
    if (mode === 'injection' && blocks.length > 0 && getSettings(document.uri).comments.highlightStrategy === 'auto') {
      this.scheduleRecheck();
    }
  }

  /** A C# language server from an unknown extension may register its semantic tokens provider late. */
  private scheduleRecheck(): void {
    this.recheckTimer ??= setTimeout(() => {
      this.recheckTimer = undefined;
      if (!this.disposed) {
        this.refresh();
      }
    }, LATE_PROVIDER_RECHECK_MS);
  }

  /** `paintDefault` is for prose (document mode): plain text is returned too, to be painted with the editor foreground. */
  private tokenize(highlighter: CodeHighlighter, body: string, language: string, paintDefault: boolean): StyledToken[][] | undefined {
    const key = `${paintDefault ? 'prose' : 'code'}\0${language}\0${body}`;
    if (this.tokenCache.has(key)) {
      const cached = this.tokenCache.get(key);
      this.tokenCache.delete(key);
      this.tokenCache.set(key, cached);
      return cached;
    }
    let lines: StyledToken[][] | undefined;
    try {
      lines = highlighter.tokenizeStyles(body, language, paintDefault);
    } catch (err) {
      this.logger.warn(`Tokenizing a /*${language} comment failed: ${err}`);
    }
    this.tokenCache.set(key, lines);
    if (this.tokenCache.size > TOKEN_CACHE_SIZE) {
      this.tokenCache.delete(this.tokenCache.keys().next().value!);
    }
    return lines;
  }

  private apply(editor: vscode.TextEditor, mode: SyntaxHighlightMode, spans: readonly SourceStyledSpan[]): void {
    const document = editor.document;
    const byKey = new Map<string, vscode.Range[]>();
    const applied: AppliedSyntaxRange[] = [];
    for (const span of spans) {
      const range = new vscode.Range(document.positionAt(span.start), document.positionAt(span.end));
      let ranges = byKey.get(span.key);
      if (!ranges) {
        ranges = [];
        byKey.set(span.key, ranges);
        if (!this.types.has(span.key)) {
          this.types.set(span.key, vscode.window.createTextEditorDecorationType(decorationOptions(span.style)));
        }
      }
      ranges.push(range);
      applied.push({ range, style: span.style });
    }
    for (const key of this.editorKeys.get(editor) ?? []) {
      if (!byKey.has(key)) {
        editor.setDecorations(this.types.get(key)!, []);
      }
    }
    for (const [key, ranges] of byKey) {
      editor.setDecorations(this.types.get(key)!, ranges);
    }
    this.editorKeys.set(editor, new Set(byKey.keys()));
    this.applied.set(document.uri.toString(), { mode, ranges: applied });
  }

  dispose(): void {
    this.disposed = true;
    if (this.recheckTimer) {
      clearTimeout(this.recheckTimer);
    }
    this.disposables.forEach((d) => d.dispose());
    this.types.forEach((t) => t.dispose());
    this.types.clear();
    this.tokenCache.clear();
    this.applied.clear();
  }
}
