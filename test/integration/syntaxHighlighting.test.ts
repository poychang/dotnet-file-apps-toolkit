import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { AppliedSyntaxHighlight } from '../../src/comments/syntaxHighlightController';
import type { ToolkitApi } from '../../src/extension';
import { activateExtension, fixtureUri, waitFor } from './helpers';

const SECTION = 'dotnetFileAppsToolkit';

/** Token as returned by VS Code's `_workbench.captureSyntaxTokens` (used by its own colorizer tests). */
interface CapturedToken {
  /** Text. */
  readonly c: string;
  /** Space-separated TextMate scopes. */
  readonly t: string;
  /** Matched theme rule and color per built-in theme, e.g. `dark_plus: "entity.name.tag: #569CD6"`. */
  readonly r: Readonly<Record<string, string | undefined>>;
}

async function captureTokens(name: string): Promise<CapturedToken[]> {
  return vscode.commands.executeCommand<CapturedToken[]>('_workbench.captureSyntaxTokens', fixtureUri(name));
}

function firstToken(tokens: readonly CapturedToken[], text: string, scope: string): CapturedToken {
  const token = tokens.find((t) => t.c.trim() === text && t.t.includes(scope));
  assert.ok(token, `No "${text}" token with scope ${scope}:\n${tokens.map((t) => `${JSON.stringify(t.c)} ${t.t}`).join('\n')}`);
  return token;
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Workspace);
}

async function open(name: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(fixtureUri(name));
  return vscode.window.showTextDocument(document, vscode.ViewColumn.One);
}

function registerFakeCSharpSemanticTokens(): vscode.Disposable {
  const legend = new vscode.SemanticTokensLegend(['comment', 'keyword'], []);
  return vscode.languages.registerDocumentSemanticTokensProvider(
    { language: 'csharp' },
    { provideDocumentSemanticTokens: () => new vscode.SemanticTokensBuilder(legend).build() },
    legend,
  );
}

describe('Tagged comment syntax highlighting', function () {
  this.timeout(120_000);
  let api: ToolkitApi;

  function applied(document: vscode.TextDocument): AppliedSyntaxHighlight | undefined {
    return api.syntaxHighlights.applied.get(document.uri.toString());
  }

  function decoratedTexts(document: vscode.TextDocument): string[] {
    return (applied(document)?.ranges ?? []).map((r) => document.getText(r.range));
  }

  /** Decorations must stay on single lines inside tagged bodies; C# code and ordinary comments are never touched. */
  function assertInsideTaggedBodies(document: vscode.TextDocument, result: AppliedSyntaxHighlight): void {
    const scan = api.comments.getScan(document);
    for (const { range } of result.ranges) {
      const start = document.offsetAt(range.start);
      const end = document.offsetAt(range.end);
      assert.ok(
        scan.blocks.some((b) => start >= b.bodyStartOffset && end <= b.bodyEndOffset),
        `Range "${document.getText(range)}" is outside tagged comment bodies`,
      );
      assert.equal(range.start.line, range.end.line);
    }
  }

  /** Waits for the applied state to match; with `refresh`, re-resolves the mode about once a second. */
  function waitForApplied(
    document: vscode.TextDocument,
    predicate: (a: AppliedSyntaxHighlight) => boolean,
    what: string,
    refresh = false,
  ): Promise<AppliedSyntaxHighlight> {
    let lastRefresh = 0;
    return waitFor(
      () => {
        if (refresh && Date.now() - lastRefresh > 1000) {
          lastRefresh = Date.now();
          api.syntaxHighlights.refresh();
        }
        const current = applied(document);
        return current && predicate(current) ? current : undefined;
      },
      15_000,
      what,
    );
  }

  before(async () => {
    api = await activateExtension();
  });

  afterEach(async () => {
    for (const key of ['comments.enabled', 'comments.highlight.enabled', 'comments.highlight.strategy']) {
      await setSetting(key, undefined);
    }
    await vscode.workspace.getConfiguration('editor').update('semanticHighlighting.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('editor').update('bracketPairColorization.enabled', undefined, vscode.ConfigurationTarget.Workspace);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('injects the embedded grammars into tagged comment bodies in the native editor', async () => {
    const tokens = await captureTokens('tagged-yaml-json-sql.cs');

    const yamlKey = firstToken(tokens, 'name', 'meta.tagged-comment.content.yaml');
    assert.match(yamlKey.t, /\bcomment\.block\.tagged\.yaml\.cs\b.*\bentity\.name\.tag\.yaml\b/);
    assert.match(yamlKey.r.dark_plus ?? '', /#569CD6/i);
    assert.match(yamlKey.r.light_plus ?? '', /#800000/i);

    const jsonKey = firstToken(tokens, 'enabled', 'meta.tagged-comment.content.json');
    assert.match(jsonKey.t, /support\.type\.property-name\.json/);
    const jsonValue = firstToken(tokens, 'true', 'meta.tagged-comment.content.json');
    assert.match(jsonValue.t, /constant\.language\.json/);
    const sqlKeyword = firstToken(tokens, 'SELECT', 'meta.tagged-comment.content.sql');
    assert.match(sqlKeyword.t, /keyword\.other\.DML\.sql/);

    const opening = firstToken(tokens, 'yaml', 'keyword.other.language-tag.cs');
    assert.match(opening.t, /comment\.block\.tagged\.yaml\.cs/);
    const after = firstToken(tokens, 'Console', 'source.cs');
    assert.doesNotMatch(after.t, /comment|tagged/);
    // Every comment closes on its own `*/`, so C# after the last block is ordinary code again.
    const closers = tokens.filter((t) => t.c === '*/');
    assert.equal(closers.length, 3);
    assert.ok(closers.every((t) => /punctuation\.definition\.comment\.cs/.test(t.t) && !/meta\.tagged-comment\.content/.test(t.t)));
  });

  it('leaves ordinary comments, documentation comments and strings unchanged', async () => {
    const ordinary = await captureTokens('ordinary-comments.cs');
    assert.deepEqual(
      ordinary.filter((t) => t.t.includes('tagged')).map((t) => t.c),
      [],
    );

    const strings = await captureTokens('strings-with-comment-markers.cs');
    const tagged = strings.filter((t) => t.t.includes('meta.tagged-comment.content'));
    assert.equal(tagged.map((t) => t.c).join(''), 'real: true');
    const json = strings.find((t) => t.c.includes('/*json'));
    assert.ok(json && /string/.test(json.t) && !/tagged/.test(json.t), JSON.stringify(json));
  });

  it('resolves the strategy from settings and the semantic highlighting environment', async () => {
    const { document } = await open('tagged-yaml-json-sql.cs');
    const mode = () => api.syntaxHighlights.resolveMode(document);

    assert.equal(await mode(), 'injection', 'auto without a semantic tokens provider');
    for (const strategy of ['injection', 'decorations', 'off'] as const) {
      await setSetting('comments.highlight.strategy', strategy);
      assert.equal(await mode(), strategy);
    }
    await setSetting('comments.highlight.strategy', 'decorations');
    await setSetting('comments.highlight.enabled', false);
    assert.equal(await mode(), 'off');
    await setSetting('comments.highlight.enabled', undefined);
    await setSetting('comments.enabled', false);
    assert.equal(await mode(), 'off');
    await setSetting('comments.enabled', undefined);
    await setSetting('comments.highlight.strategy', undefined);

    const provider = registerFakeCSharpSemanticTokens();
    try {
      await waitFor(async () => (await mode()) === 'decorations', 10_000, 'auto to pick decorations with a C# semantic tokens provider');
      await vscode.workspace.getConfiguration('editor').update('semanticHighlighting.enabled', false, vscode.ConfigurationTarget.Workspace);
      assert.equal(await mode(), 'injection', 'semantic highlighting disabled');
    } finally {
      provider.dispose();
    }
    await vscode.workspace.getConfiguration('editor').update('semanticHighlighting.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor(async () => (await mode()) === 'injection', 10_000, 'auto to return to injection');
  });

  it('decorates only tagged code bodies with theme colors and clears them when turned off', async () => {
    const { document } = await open('tagged-yaml-json-sql.cs');
    await setSetting('comments.highlight.strategy', 'decorations');
    const result = await waitForApplied(document, (a) => a.mode === 'decorations' && a.ranges.length > 0, 'decorations');

    assertInsideTaggedBodies(document, result);
    const styleOf = (text: string) => result.ranges.find((r) => document.getText(r.range) === text)?.style;
    assert.deepEqual(styleOf('name'), { light: '#800000', dark: '#569CD6', fontStyle: 0 });
    assert.equal(styleOf('"enabled"')?.dark, '#9CDCFE');
    assert.equal(styleOf('3')?.dark, '#B5CEA8');
    assert.equal(styleOf('SELECT')?.dark, '#569CD6');

    await setSetting('comments.highlight.strategy', 'off');
    await waitForApplied(document, (a) => a.mode === 'off' && a.ranges.length === 0, 'decorations to be removed');
  });

  it('colors JSON brackets with the VS Code bracket palette and separators with the editor foreground', async () => {
    const { document } = await open('tagged-yaml-json-sql.cs');
    const styleAt = (result: AppliedSyntaxHighlight, offset: number) =>
      result.ranges.find(({ range }) => {
        const start = document.offsetAt(range.start);
        const end = document.offsetAt(range.end);
        return start <= offset && offset < end;
      })?.style;

    await setSetting('comments.highlight.strategy', 'decorations');
    let result = await waitForApplied(document, (a) => a.mode === 'decorations' && a.ranges.length > 0, 'JSON decorations');
    const bodyStart = document.getText().indexOf('/*json');
    const openOffset = document.getText().indexOf('{', bodyStart);
    const close = document.getText().indexOf('}', openOffset);
    const colon = document.getText().indexOf(':', openOffset);
    const comma = document.getText().indexOf(',', colon);
    assert.equal(styleAt(result, openOffset)?.themeColor, 'editorBracketHighlight.foreground1');
    assert.equal(styleAt(result, close)?.themeColor, 'editorBracketHighlight.foreground1');
    assert.ok(styleAt(result, colon)?.foreground, 'colon uses the editor foreground');
    assert.ok(styleAt(result, comma)?.foreground, 'comma uses the editor foreground');

    await setSetting('comments.highlight.strategy', 'injection');
    result = await waitForApplied(document, (a) => a.mode === 'injection' && a.ranges.length > 0, 'JSON delimiter decorations in injection mode');
    assert.equal(styleAt(result, openOffset)?.themeColor, 'editorBracketHighlight.foreground1');
    assert.ok(styleAt(result, colon)?.foreground);
    assert.ok(styleAt(result, comma)?.foreground);

    await vscode.workspace.getConfiguration('editor').update('bracketPairColorization.enabled', false, vscode.ConfigurationTarget.Workspace);
    await waitForApplied(
      document,
      (a) => a.mode === 'injection' && styleAt(a, openOffset)?.foreground === true,
      'JSON bracket colors to follow the editor setting',
    );
    await vscode.workspace.getConfiguration('editor').update('bracketPairColorization.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    await waitForApplied(
      document,
      (a) => a.mode === 'injection' && styleAt(a, openOffset)?.themeColor === 'editorBracketHighlight.foreground1',
      'JSON bracket colors to be restored',
    );

    await setSetting('comments.highlight.strategy', 'off');
    await waitForApplied(document, (a) => a.mode === 'off' && a.ranges.length === 0, 'JSON decorations to be removed');
  });

  it('colors Markdown bodies like a .md file and paints plain text with the editor foreground', async () => {
    const { document } = await open('tagged-markdown.cs');
    await setSetting('comments.highlight.strategy', 'decorations');
    const result = await waitForApplied(document, (a) => a.mode === 'decorations' && a.ranges.length > 0, 'Markdown decorations');

    assertInsideTaggedBodies(document, result);
    const styleOf = (text: string) => result.ranges.find((r) => document.getText(r.range) === text)?.style;
    assert.deepEqual(styleOf('# Inventory Utility'), { light: '#800000', dark: '#569CD6', fontStyle: 2 });
    assert.equal(styleOf('**inventory**')?.dark, '#569CD6');
    assert.equal(styleOf('`dotnet run --file tagged-markdown.cs`')?.dark, '#CE9178');
    assert.equal(styleOf('-')?.dark, '#6796E6');
    assert.equal(styleOf('mode')?.dark, '#569CD6', 'YAML inside a Markdown fence');
    const plain = styleOf('This application validates ');
    assert.ok(plain?.foreground && !plain.light && !plain.dark, 'plain text uses the editor foreground');
    assert.ok(!decoratedTexts(document).some((t) => t.includes('Console')), 'C# code stays untouched');

    await setSetting('comments.highlight.strategy', 'off');
    await waitForApplied(document, (a) => a.mode === 'off' && a.ranges.length === 0, 'Markdown decorations to be removed');
  });

  it('switches auto mode to decorations when a C# semantic tokens provider appears', async () => {
    const { document } = await open('tagged-yaml-json-sql.cs');
    const injected = await waitForApplied(document, (a) => a.mode === 'injection', 'injection mode', true);
    assert.ok(injected.ranges.length > 0, 'JSON delimiters are corrected even in injection mode');
    assert.ok(injected.ranges.every(({ style }) => style.foreground || style.themeColor), 'only JSON delimiter colors are decorated');

    const provider = registerFakeCSharpSemanticTokens();
    try {
      await waitForApplied(document, (a) => a.mode === 'decorations' && a.ranges.length > 0, 'decorations after the provider registered', true);
    } finally {
      provider.dispose();
    }
    await waitForApplied(
      document,
      (a) => a.mode === 'injection' && a.ranges.length > 0 && a.ranges.every(({ style }) => style.foreground || style.themeColor),
      'injection after the provider was removed',
      true,
    );
  });

  it('follows edits to the document', async () => {
    await setSetting('comments.highlight.strategy', 'decorations');
    const document = await vscode.workspace.openTextDocument({ language: 'csharp', content: 'var a = 1;\n/*yaml\nalpha: 1\n*/\n' });
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    try {
      await waitFor(() => decoratedTexts(document).includes('alpha'), 15_000, 'initial decorations');

      await editor.edit((e) => e.insert(new vscode.Position(3, 0), 'beta: "two"\n'));
      await waitFor(() => decoratedTexts(document).includes('"two"'), 10_000, 'decorations for inserted text');
      assert.deepEqual(decoratedTexts(document), ['alpha', '1', 'beta', '"two"']);

      await editor.edit((e) => e.replace(new vscode.Range(1, 0, 1, 6), '/* yaml'));
      await waitForApplied(document, (a) => a.ranges.length === 0, 'decorations to clear for an ordinary comment');
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
});
