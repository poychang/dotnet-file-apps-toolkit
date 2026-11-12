/**
 * Single source of truth for the languages that may appear in explicitly tagged C# block comments
 * (`/*yaml`, `/*markdown`, ...). The registry is a fixed allowlist: unknown tags are never interpreted
 * and nothing is loaded dynamically from workspace content.
 */

export type RenderMode = 'document' | 'code';

export interface EmbeddedLanguageDescriptor {
  /** Canonical, lowercase ID such as `markdown` or `yaml`. */
  readonly id: string;
  readonly displayName: string;
  /** Additional accepted tags (lowercase). */
  readonly aliases: readonly string[];
  readonly mode: RenderMode;
  /** TextMate scope of the language grammar used for in-editor highlighting. */
  readonly grammarScope?: string;
  /** VS Code language ID used for embedded-language scopes. */
  readonly vscodeLanguageId?: string;
  /** Language ID understood by the preview syntax highlighter. Undefined for document mode. */
  readonly previewLanguage?: string;
  /** Rich hover over the comment body. */
  readonly hover?: boolean;
}

/**
 * Characters allowed in a language tag. A tag starts with an ASCII letter so `/**`, `/* ` and `/*-`
 * never qualify.
 */
export const TAG_PATTERN = /[A-Za-z][A-Za-z0-9_.+#-]*/y;

const MVP_LANGUAGES: readonly EmbeddedLanguageDescriptor[] = [
  {
    id: 'markdown',
    displayName: 'Markdown',
    aliases: ['md'],
    mode: 'document',
    grammarScope: 'text.html.markdown',
    vscodeLanguageId: 'markdown',
    hover: true,
  },
  {
    id: 'yaml',
    displayName: 'YAML',
    aliases: ['yml'],
    mode: 'code',
    grammarScope: 'source.yaml',
    vscodeLanguageId: 'yaml',
    previewLanguage: 'yaml',
  },
  {
    id: 'json',
    displayName: 'JSON',
    aliases: [],
    mode: 'code',
    grammarScope: 'source.json',
    vscodeLanguageId: 'json',
    previewLanguage: 'json',
  },
  {
    id: 'sql',
    displayName: 'SQL',
    aliases: [],
    mode: 'code',
    grammarScope: 'source.sql',
    vscodeLanguageId: 'sql',
    previewLanguage: 'sql',
  },
  {
    id: 'xml',
    displayName: 'XML',
    aliases: [],
    mode: 'code',
    grammarScope: 'text.xml',
    vscodeLanguageId: 'xml',
    previewLanguage: 'xml',
  },
  {
    id: 'bash',
    displayName: 'Bash',
    aliases: ['sh', 'shell'],
    mode: 'code',
    grammarScope: 'source.shell',
    vscodeLanguageId: 'shellscript',
    previewLanguage: 'shellscript',
  },
  {
    id: 'powershell',
    displayName: 'PowerShell',
    aliases: ['ps1'],
    mode: 'code',
    grammarScope: 'source.powershell',
    vscodeLanguageId: 'powershell',
    previewLanguage: 'powershell',
  },
  {
    id: 'csharp',
    displayName: 'C#',
    aliases: ['cs'],
    mode: 'code',
    grammarScope: 'source.cs',
    vscodeLanguageId: 'csharp',
    previewLanguage: 'csharp',
  },
];

export class EmbeddedLanguageRegistry {
  private readonly byTag = new Map<string, EmbeddedLanguageDescriptor>();

  constructor(readonly languages: readonly EmbeddedLanguageDescriptor[]) {
    for (const lang of languages) {
      for (const tag of [lang.id, ...lang.aliases]) {
        const key = tag.toLowerCase();
        if (this.byTag.has(key)) {
          throw new Error(`Duplicate embedded language tag "${tag}"`);
        }
        this.byTag.set(key, lang);
      }
    }
  }

  /** Resolves a tag or alias case-insensitively. */
  resolve(tag: string): EmbeddedLanguageDescriptor | undefined {
    return this.byTag.get(tag.toLowerCase());
  }

  /** All accepted tags (canonical IDs and aliases), in registry order. */
  allTags(): string[] {
    return this.languages.flatMap((l) => [l.id, ...l.aliases]);
  }
}

export const defaultRegistry = new EmbeddedLanguageRegistry(MVP_LANGUAGES);
