import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Grammar, HighlighterCore } from 'shiki/core';
import { defaultRegistry } from '../../src/comments/embeddedLanguageRegistry';

const GRAMMAR_PATH = path.join(__dirname, '..', '..', 'syntaxes', 'tagged-comments.injection.tmLanguage.json');

interface ScopedToken {
  readonly line: number;
  readonly start: number;
  readonly text: string;
  readonly lineText: string;
  readonly scopes: readonly string[];
}

/**
 * Exercises the injection grammar with the same TextMate engine family and Oniguruma regex engine that VS
 * Code uses, against Shiki's copies of the C# and embedded grammars. The integration tests repeat the key
 * checks with VS Code's own built-in grammars.
 */
describe('Tagged comment injection grammar', function () {
  this.timeout(30_000);
  let core: HighlighterCore;
  let csharp: Grammar;
  let INITIAL: Parameters<Grammar['tokenizeLine']>[1];

  before(async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }, textmate] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/oniguruma'),
      import('shiki/textmate'),
    ]);
    INITIAL = textmate.INITIAL;
    const injection = JSON.parse(readFileSync(GRAMMAR_PATH, 'utf8'));
    core = await createHighlighterCore({
      langs: [
        import('@shikijs/langs/yaml'),
        import('@shikijs/langs/json'),
        import('@shikijs/langs/sql'),
        import('@shikijs/langs/xml'),
        import('@shikijs/langs/shellscript'),
        import('@shikijs/langs/powershell'),
        import('@shikijs/langs/markdown'),
        import('@shikijs/langs/csharp'),
        { ...injection, name: 'tagged-comments-injection', injectTo: ['source.cs'] },
      ],
      themes: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
    csharp = core.getLanguage('csharp');
  });

  after(() => core?.dispose());

  function tokenize(source: string): ScopedToken[] {
    let state = INITIAL;
    const out: ScopedToken[] = [];
    source.split('\n').forEach((text, line) => {
      const result = csharp.tokenizeLine(text, state);
      for (const t of result.tokens) {
        out.push({ line, start: t.startIndex, text: text.slice(t.startIndex, t.endIndex), lineText: text, scopes: t.scopes });
      }
      state = result.ruleStack;
    });
    return out;
  }

  /** The token covering the first character of `text` on `line` (grammars may split words into several tokens). */
  function tokenAt(tokens: readonly ScopedToken[], line: number, text: string): ScopedToken {
    const onLine = tokens.filter((t) => t.line === line);
    const column = onLine[0]?.lineText.indexOf(text) ?? -1;
    const token = column < 0 ? undefined : onLine.find((t) => t.start <= column && column < t.start + t.text.length);
    assert.ok(token, `no token containing "${text}" on line ${line}: ${JSON.stringify(tokens.filter((t) => t.line === line))}`);
    return token;
  }

  const hasScope = (t: ScopedToken, scope: string) => t.scopes.some((s) => s === scope || s.startsWith(scope + '.'));
  const tagged = (t: ScopedToken) => t.scopes.some((s) => s.startsWith('comment.block.tagged.'));

  it('highlights a YAML body inside the comment and returns to C# after */', () => {
    const tokens = tokenize(['/*yaml', 'name: inventory-app', 'features:', '  - validate', '*/', 'var x = 1;'].join('\n'));
    const open = tokenAt(tokens, 0, '/*');
    assert.ok(hasScope(open, 'comment.block.tagged.yaml.cs') && hasScope(open, 'punctuation.definition.comment.cs'));
    assert.ok(hasScope(tokenAt(tokens, 0, 'yaml'), 'keyword.other.language-tag.cs'));

    const key = tokenAt(tokens, 1, 'name');
    assert.ok(hasScope(key, 'meta.tagged-comment.content.yaml'), key.scopes.join(' '));
    assert.ok(key.scopes.some((s) => s.startsWith('entity.name.tag') && s.endsWith('.yaml')), key.scopes.join(' '));
    const value = tokenAt(tokens, 1, 'inventory-app');
    assert.ok(value.scopes.some((s) => s.startsWith('string') && s.endsWith('.yaml')), value.scopes.join(' '));
    assert.ok(tokenAt(tokens, 3, 'validate').scopes.some((s) => s.endsWith('.yaml') && s.startsWith('string')));

    const close = tokenAt(tokens, 4, '*/');
    assert.ok(hasScope(close, 'comment.block.tagged.yaml.cs') && !hasScope(close, 'meta.tagged-comment.content'));
    const code = tokenAt(tokens, 5, 'var');
    assert.ok(!code.scopes.some((s) => s.startsWith('comment')), code.scopes.join(' '));
    assert.ok(code.scopes.some((s) => s.startsWith('storage.type') || s.startsWith('keyword')), code.scopes.join(' '));
  });

  it('never lets an unfinished embedded construct swallow the closing */', () => {
    for (const source of [
      ['/*json', '{', '  "a": [1, 2', '*/', 'var y = 2;'],
      ['/*yaml', 'text: |', '  block scalar', '*/', 'var y = 2;'],
      ['/*xml', '<root attr="open', '*/', 'var y = 2;'],
      ['/*bash', 'echo "unterminated', '*/', 'var y = 2;'],
      ['/*sql', "SELECT 'open", '*/', 'var y = 2;'],
    ]) {
      const tokens = tokenize(source.join('\n'));
      const last = source.length - 1;
      const code = tokenAt(tokens, last, 'var');
      assert.ok(!code.scopes.some((s) => s.startsWith('comment') || s.includes('tagged')), `${source[0]}: ${code.scopes.join(' ')}`);
    }
  });

  it('ends the comment at the first */ on the line, like C#', () => {
    const inline = tokenize(['/*yaml', 'key: value */ var z = 3;'].join('\n'));
    assert.ok(!tagged(tokenAt(inline, 1, 'var')));
    assert.ok(tagged(tokenAt(inline, 1, 'key')));

    const nested = tokenize(['/*sql', 'SELECT 1; /* note */', 'SELECT 2;'].join('\n'));
    assert.ok(!tagged(tokenAt(nested, 2, 'SELECT')), 'SQL after the first */ is C# code');
  });

  it('only matches the documented opening syntax', () => {
    for (const source of ['/*yaml key: value */', '/* yaml\nkey: value\n*/', '/*yamlx\nkey: value\n*/', '/**yaml\nkey: value\n*/']) {
      const tokens = tokenize(source);
      assert.ok(!tokens.some(tagged), `${JSON.stringify(source)} must stay an ordinary comment`);
    }
    const trailing = tokenize('/*YML  \t\nkey: value\n*/');
    assert.ok(tagged(tokenAt(trailing, 1, 'key')), 'case-insensitive tag with trailing whitespace');
  });

  it('ignores tag-like text inside strings and line comments', () => {
    const tokens = tokenize(
      [
        'var a = "/*yaml";',
        'var b = @"/*json',
        '{ }',
        '*/";',
        '// /*sql',
        'var c = 1;',
      ].join('\n'),
    );
    assert.ok(!tokens.some(tagged), JSON.stringify(tokens.filter(tagged)));
    assert.ok(!tokenAt(tokens, 5, 'var').scopes.some((s) => s.startsWith('comment')));
  });

  it('keeps sibling comments and Markdown comments as ordinary comments', () => {
    const tokens = tokenize(['/*yaml', 'a: 1', '*/ /* plain */', '/*markdown', '# Title', '*/'].join('\n'));
    const plain = tokenAt(tokens, 2, 'plain');
    assert.ok(hasScope(plain, 'comment.block.cs') && !tagged(plain));
    assert.ok(!tagged(tokenAt(tokens, 4, 'Title')), 'Markdown uses editor decorations, not injection');
  });

  it('covers exactly the code-mode languages and aliases of the registry', () => {
    const grammar = JSON.parse(readFileSync(GRAMMAR_PATH, 'utf8')) as { repository: Record<string, { name: string }> };
    const injected = Object.values(grammar.repository).map((r) => r.name.replace(/^comment\.block\.tagged\.(.+)\.cs$/, '$1'));
    for (const tag of defaultRegistry.allTags()) {
      const descriptor = defaultRegistry.resolve(tag);
      assert.ok(descriptor);
      const tokens = tokenize(`/*${tag}\nx\n*/`);
      const scope = `comment.block.tagged.${descriptor.id}.cs`;
      if (descriptor.mode === 'code') {
        assert.ok(injected.includes(descriptor.id), `${descriptor.id} has no injection rule`);
        assert.ok(hasScope(tokenAt(tokens, 1, 'x'), scope), `/*${tag}: ${tokenAt(tokens, 1, 'x').scopes.join(' ')}`);
        assert.ok(hasScope(tokenAt(tokens, 1, 'x'), `meta.tagged-comment.content.${descriptor.id}`));
      } else {
        assert.ok(!tokens.some(tagged), `/*${tag} must not be injected`);
      }
    }
    const codeIds = defaultRegistry.allTags().map((t) => defaultRegistry.resolve(t)!).filter((d) => d.mode === 'code').map((d) => d.id);
    assert.deepEqual([...new Set(injected)].sort(), [...new Set(codeIds)].sort());
  });

  it('applies each embedded grammar', () => {
    const cases: [string, string, RegExp][] = [
      ['json', '{ "name": true }', /\.json$/],
      ['sql', 'SELECT name FROM users;', /\.sql$/],
      ['xml', '<item id="a" />', /\.xml$/],
      ['bash', 'echo "hi" | grep h', /\.shell$/],
      ['powershell', 'Get-ChildItem -Path $env:HOME', /\.powershell$/],
      ['csharp', 'var greeting = $"Hello";', /\.cs$/],
    ];
    for (const [tag, body, pattern] of cases) {
      const tokens = tokenize(`/*${tag}\n${body}\n*/`).filter((t) => t.line === 1 && t.text.trim());
      const languageScoped = tokens.filter((t) => t.scopes.slice(t.scopes.indexOf(`meta.tagged-comment.content.${tag}`) + 1).some((s) => pattern.test(s)));
      assert.ok(languageScoped.length > 0, `${tag}: ${JSON.stringify(tokens)}`);
    }
  });
});
