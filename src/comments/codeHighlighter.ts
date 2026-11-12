import type { HighlighterCore, ThemedTokenWithVariants } from 'shiki/core';
import { escapeHtml } from './markdownRenderer';

/**
 * Syntax highlighting for preview code blocks. Shiki tokenizes with VS Code's Light+ and Dark+ themes,
 * and colors are emitted as CSS classes (never inline styles) so the preview can keep a strict CSP.
 * Only the bundled MVP grammars are loaded; nothing is resolved from workspace content.
 */

const LIGHT_THEME = 'light-plus';
const DARK_THEME = 'dark-plus';
const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;
/** Bodies above this size are shown as plain text to keep tokenization bounded. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

export interface HighlightedToken {
  readonly text: string;
  /** Space-separated CSS classes, empty for default-colored text. */
  readonly classes: string;
}

/** Colors of a token for light and dark themes; undefined colors mean the theme's default foreground. */
export interface TokenStyle {
  readonly light?: string;
  readonly dark?: string;
  /** Bit set of italic (1), bold (2) and underline (4), only when both themes agree. */
  readonly fontStyle: number;
}

/** A styled token by column range within its line. Default-styled tokens are omitted. */
export interface StyledToken {
  readonly start: number;
  readonly end: number;
  readonly style: TokenStyle;
}

class Palette {
  private readonly index = new Map<string, number>();
  readonly colors: string[] = [];

  constructor(
    readonly prefix: string,
    readonly foreground: string,
  ) {}

  add(color: string | undefined): void {
    const key = color?.toUpperCase();
    if (key && key !== this.foreground && !this.index.has(key)) {
      this.index.set(key, this.colors.length);
      this.colors.push(key);
    }
  }

  classFor(color: string | undefined): string | undefined {
    const i = color ? this.index.get(color.toUpperCase()) : undefined;
    return i === undefined ? undefined : `${this.prefix}${i}`;
  }

  /** Normalized color, or undefined for the default foreground and unknown colors. */
  colorFor(color: string | undefined): string | undefined {
    const key = color?.toUpperCase();
    return key && this.index.has(key) ? key : undefined;
  }
}

function collectPalette(core: HighlighterCore, theme: string, prefix: string): Palette {
  const resolved = core.getTheme(theme);
  const palette = new Palette(prefix, resolved.fg.toUpperCase());
  for (const rule of resolved.settings ?? []) {
    palette.add(rule.settings?.foreground);
  }
  return palette;
}

export class CodeHighlighter {
  private readonly light: Palette;
  private readonly dark: Palette;
  private readonly languages: Set<string>;

  private constructor(private readonly core: HighlighterCore) {
    this.light = collectPalette(core, LIGHT_THEME, 'l');
    this.dark = collectPalette(core, DARK_THEME, 'd');
    this.languages = new Set(core.getLoadedLanguages());
  }

  static async create(): Promise<CodeHighlighter> {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    const core = await createHighlighterCore({
      langs: [
        import('@shikijs/langs/yaml'),
        import('@shikijs/langs/json'),
        import('@shikijs/langs/sql'),
        import('@shikijs/langs/xml'),
        import('@shikijs/langs/shellscript'),
        import('@shikijs/langs/powershell'),
        import('@shikijs/langs/csharp'),
      ],
      themes: [import('@shikijs/themes/light-plus'), import('@shikijs/themes/dark-plus')],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    return new CodeHighlighter(core);
  }

  supports(language: string): boolean {
    return this.languages.has(language);
  }

  /** CSS for the token classes: Dark+ colors for dark/high-contrast themes, Light+ for light ones. */
  get css(): string {
    const rules: string[] = [];
    this.dark.colors.forEach((c, i) =>
      rules.push(`body.vscode-dark .d${i},body.vscode-high-contrast:not(.vscode-high-contrast-light) .d${i}{color:${c}}`),
    );
    this.light.colors.forEach((c, i) =>
      rules.push(`body.vscode-light .l${i},body.vscode-high-contrast-light .l${i}{color:${c}}`),
    );
    rules.push('.fi{font-style:italic}.fb{font-weight:bold}.fu{text-decoration:underline}');
    return rules.join('\n');
  }

  /** Tokenizes `code` into lines, or returns undefined when the language is not loaded or the input is too large. */
  tokenize(code: string, language: string): HighlightedToken[][] | undefined {
    return this.tokenizeWithThemes(code, language)?.map((line) => line.map((t) => ({ text: t.content, classes: this.classesFor(t) })));
  }

  /** Per-line styled column ranges for editor decorations; default-colored tokens are left out. */
  tokenizeStyles(code: string, language: string): StyledToken[][] | undefined {
    return this.tokenizeWithThemes(code, language)?.map((line) => {
      const out: StyledToken[] = [];
      let column = 0;
      for (const t of line) {
        const start = column;
        column += t.content.length;
        const style = this.styleFor(t);
        if (style && t.content.trim()) {
          out.push({ start, end: column, style });
        }
      }
      return out;
    });
  }

  private tokenizeWithThemes(code: string, language: string): ThemedTokenWithVariants[][] | undefined {
    if (!this.supports(language) || code.length > MAX_HIGHLIGHT_CHARS) {
      return undefined;
    }
    return this.core.codeToTokensWithThemes(code, {
      lang: language,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      tokenizeMaxLineLength: 5000,
    });
  }

  /** Highlighted `<pre>` HTML without line numbers, for fenced code inside Markdown. */
  highlightToHtml(code: string, language: string): string | undefined {
    const lines = this.tokenize(code.replace(/\n$/, ''), language);
    if (!lines) {
      return undefined;
    }
    const body = lines.map((line) => tokensToHtml(line)).join('\n');
    return `<pre class="code" data-lang="${escapeHtml(language)}"><code>${body}</code></pre>`;
  }

  private styleFor(token: ThemedTokenWithVariants): TokenStyle | undefined {
    const light = this.light.colorFor(token.variants.light?.color);
    const dark = this.dark.colorFor(token.variants.dark?.color);
    const lightFont = token.variants.light?.fontStyle ?? 0;
    const fontStyle = lightFont > 0 && lightFont === (token.variants.dark?.fontStyle ?? 0) ? lightFont : 0;
    return light || dark || fontStyle ? { light, dark, fontStyle } : undefined;
  }

  private classesFor(token: ThemedTokenWithVariants): string {
    const light = token.variants.light;
    const dark = token.variants.dark;
    const classes = [this.light.classFor(light?.color), this.dark.classFor(dark?.color)];
    const style = light?.fontStyle ?? 0;
    if (style > 0 && style === (dark?.fontStyle ?? 0)) {
      if (style & FONT_ITALIC) {
        classes.push('fi');
      }
      if (style & FONT_BOLD) {
        classes.push('fb');
      }
      if (style & FONT_UNDERLINE) {
        classes.push('fu');
      }
    }
    return classes.filter(Boolean).join(' ');
  }
}

export function tokensToHtml(tokens: readonly HighlightedToken[]): string {
  return tokens.map((t) => (t.classes ? `<span class="${t.classes}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text))).join('');
}
