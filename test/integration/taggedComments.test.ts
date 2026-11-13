import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import type { ToolkitApi } from '../../src/extension';
import { activateExtension, fixtureUri, restoreDocumentFromDisk, UiStub, waitFor } from './helpers';

const SECTION = 'dotnetFileAppsToolkit';

async function open(name: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(fixtureUri(name));
  return vscode.window.showTextDocument(document, vscode.ViewColumn.One);
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Workspace);
}

function hoverText(hovers: readonly vscode.Hover[]): string {
  return hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
}

function positionOf(document: vscode.TextDocument, needle: string): vscode.Position {
  const offset = document.getText().indexOf(needle);
  assert.ok(offset >= 0, `"${needle}" not found in ${document.uri.fsPath}`);
  return document.positionAt(offset + 1);
}

async function hoverAt(document: vscode.TextDocument, needle: string): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, positionOf(document, needle));
  return hoverText(hovers ?? []);
}

describe('Tagged comments', function () {
  this.timeout(120_000);
  const ui = new UiStub();
  let api: ToolkitApi;
  const originals = new Map<string, string>();

  before(async () => {
    api = await activateExtension();
    ui.install();
    for (const name of ['tagged-markdown.cs', 'tagged-yaml-json-sql.cs', 'multi-language-comments.cs', 'ordinary-comments.cs', 'strings-with-comment-markers.cs']) {
      originals.set(name, await fs.readFile(fixtureUri(name).fsPath, 'utf8'));
    }
  });

  after(async () => {
    ui.restore();
    for (const key of [
      'comments.enabled',
      'comments.markdown.hover',
      'comments.highlight.enabled',
      'comments.unknownTagDiagnostic',
      'comments.validation.enabled',
    ]) {
      await setSetting(key, undefined);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  beforeEach(() => ui.reset());

  it('detects tagged comments only where they exist', async () => {
    const tagged = await open('multi-language-comments.cs');
    await waitFor(() => api.comments.hasTaggedComments(tagged.document.uri), 10_000, 'tagged comment detection');
    const languages = api.comments.getScan(tagged.document).blocks.map((b) => b.language);
    assert.deepEqual(languages, ['markdown', 'xml', 'bash', 'powershell', 'csharp', 'yaml']);

    const ordinary = await open('ordinary-comments.cs');
    assert.equal(api.comments.getScan(ordinary.document).blocks.length, 0);
    assert.equal(api.comments.hasTaggedComments(ordinary.document.uri), false);

    const strings = await open('strings-with-comment-markers.cs');
    const blocks = api.comments.getScan(strings.document).blocks;
    assert.deepEqual(
      blocks.map((b) => [b.language, b.normalizedBody]),
      [['yaml', 'real: true']],
    );
  });

  it('shows a Markdown hover inside /*markdown blocks only', async () => {
    const { document } = await open('tagged-markdown.cs');
    const text = await hoverAt(document, 'validates **inventory**');
    assert.match(text, /# Inventory Utility/);
    assert.match(text, /\| Option \| Default \|/);

    assert.equal(await hoverAt(document, 'Console.WriteLine'), '');

    const yaml = await open('tagged-yaml-json-sql.cs');
    assert.equal(await hoverAt(yaml.document, 'environment: production'), '', 'YAML blocks have no Markdown hover');

    const strings = await open('strings-with-comment-markers.cs');
    assert.equal(await hoverAt(strings.document, '# Not a heading'), '', 'strings never produce hovers');

    await setSetting('comments.markdown.hover', false);
    try {
      assert.equal(await hoverAt(document, 'validates **inventory**'), '');
    } finally {
      await setSetting('comments.markdown.hover', undefined);
    }
  });

  it('decorates Markdown emphasis without touching other blocks', async () => {
    const editor = await open('tagged-markdown.cs');
    const key = editor.document.uri.toString();
    const ranges = await waitFor(() => {
      const applied = api.markdownDecorations.applied.get(key);
      return applied && applied.bold.length > 0 ? applied : undefined;
    }, 10_000, 'markdown decorations');
    const textOf = (r: vscode.Range) => editor.document.getText(r);
    assert.ok(ranges.bold.map(textOf).includes('**inventory**'), `bold: ${ranges.bold.map(textOf).join(' | ')}`);
    assert.ok(ranges.italic.map(textOf).includes('*JSON*'));
    assert.ok(ranges.code.map(textOf).includes('`dotnet run --file tagged-markdown.cs`'));
    assert.ok(ranges.link.map(textOf).some((t) => t.startsWith('[the docs]')));

    await setSetting('comments.highlight.enabled', false);
    try {
      await waitFor(() => api.markdownDecorations.applied.get(key)?.bold.length === 0 || undefined, 10_000, 'decorations removed');
    } finally {
      await setSetting('comments.highlight.enabled', undefined);
    }
    await waitFor(() => (api.markdownDecorations.applied.get(key)?.bold.length ?? 0) > 0 || undefined, 10_000, 'decorations restored');
  });

  it('previews every tagged block with the expected renderer', async () => {
    const uri = fixtureUri('multi-language-comments.cs');
    await open('multi-language-comments.cs');
    await vscode.commands.executeCommand('dotnetFileApps.previewComments', uri);
    const preview = api.previews.get(uri);
    assert.ok(preview, 'preview panel was not created');
    const snapshot = await waitFor(() => preview.snapshot, 10_000, 'preview snapshot');
    assert.deepEqual(
      snapshot.blocks.map((b) => [b.language, b.renderer]),
      [
        ['markdown', 'markdown'],
        ['xml', 'highlight'],
        ['bash', 'highlight'],
        ['powershell', 'highlight'],
        ['csharp', 'highlight'],
        ['yaml', 'highlight'],
      ],
    );
    assert.match(snapshot.html, /<h2>Deployment notes<\/h2>/);
    assert.doesNotMatch(snapshot.html, /unknownLanguage/);

    const md = fixtureUri('tagged-markdown.cs');
    await open('tagged-markdown.cs');
    await vscode.commands.executeCommand('dotnetFileApps.previewComments', md);
    const mdSnapshot = await waitFor(() => api.previews.get(md)?.snapshot, 10_000, 'markdown preview');
    assert.doesNotMatch(mdSnapshot.html, /<script/i, 'raw HTML must never reach the preview');
    assert.match(mdSnapshot.html, /<table>/);
    assert.match(mdSnapshot.html, /rel="noopener noreferrer"/);
  });

  it('reveals source lines, copies raw bodies and ignores invalid messages', async () => {
    const uri = fixtureUri('tagged-yaml-json-sql.cs');
    const editor = await open('tagged-yaml-json-sql.cs');
    const preview = await vscode.commands
      .executeCommand('dotnetFileApps.previewComments', uri)
      .then(() => waitFor(() => api.previews.get(uri), 10_000, 'preview'));
    const yaml = api.comments.getScan(editor.document).blocks[0];

    await preview.handleMessage({ type: 'reveal', block: 0, line: 2 });
    const active = await waitFor(
      () => (vscode.window.activeTextEditor?.document.uri.toString() === uri.toString() ? vscode.window.activeTextEditor : undefined),
      10_000,
      'source editor focus',
    );
    assert.equal(active.document.lineAt(active.selection.active.line).text, 'features:');

    await vscode.env.clipboard.writeText('sentinel');
    await preview.handleMessage({ type: 'copy', block: 0 });
    assert.equal(await vscode.env.clipboard.readText(), yaml.rawBody);
    assert.match(yaml.rawBody, /^name: inventory-app\r?\nenvironment: production\r?\nfeatures:\r?\n {2}- validate/);

    await vscode.env.clipboard.writeText('sentinel');
    for (const bad of [{ type: 'copy', block: 99 }, { type: 'copy', block: -1 }, { type: 'run', command: 'x' }, 'copy', null]) {
      await preview.handleMessage(bad);
    }
    assert.equal(await vscode.env.clipboard.readText(), 'sentinel');
    assert.deepEqual(ui.errors(), []);
  });

  it('updates the preview while editing without saving the source', async () => {
    const uri = fixtureUri('tagged-yaml-json-sql.cs');
    const editor = await open('tagged-yaml-json-sql.cs');
    await vscode.commands.executeCommand('dotnetFileApps.previewComments', uri);
    const preview = await waitFor(() => api.previews.get(uri), 10_000, 'preview');
    const before = await waitFor(() => preview.snapshot, 10_000, 'snapshot');
    assert.equal(before.blocks.length, 3);

    try {
      await editor.edit((b) => b.insert(new vscode.Position(editor.document.lineCount, 0), '\n/*xml\n<added />\n*/\n'));
      const after = await waitFor(
        () => (preview.snapshot && preview.snapshot.blocks.length === 4 ? preview.snapshot : undefined),
        10_000,
        'preview refresh',
      );
      assert.equal(after.blocks[3].language, 'xml');
    } finally {
      await restoreDocumentFromDisk(editor.document);
    }
    await waitFor(() => (preview.snapshot?.blocks.length === 3 ? true : undefined), 10_000, 'preview after restore');
  });

  it('reports unknown tags only when the diagnostic is enabled', async () => {
    const { document } = await open('multi-language-comments.cs');
    assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0);

    await setSetting('comments.unknownTagDiagnostic', true);
    try {
      const diagnostics = await waitFor(
        () => {
          const d = vscode.languages.getDiagnostics(document.uri).filter((x) => x.code === 'unknown-comment-tag');
          return d.length > 0 ? d : undefined;
        },
        10_000,
        'unknown tag diagnostic',
      );
      assert.equal(diagnostics.length, 1);
      assert.equal(document.getText(diagnostics[0].range), 'unknownLanguage');
      assert.equal(diagnostics[0].severity, vscode.DiagnosticSeverity.Information);
    } finally {
      await setSetting('comments.unknownTagDiagnostic', undefined);
    }
    await waitFor(() => vscode.languages.getDiagnostics(document.uri).length === 0 || undefined, 10_000, 'diagnostic cleared');
  });

  it('validates YAML and JSON only when opted in and maps errors to source', async () => {
    await setSetting('comments.validation.enabled', false);
    const document = await vscode.workspace.openTextDocument({
      language: 'csharp',
      content: ['/*json', '{"enabled": }', '*/'].join('\n'),
    });
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const validationCodes = () =>
      vscode.languages.getDiagnostics(document.uri).filter((d) => d.code === 'json-validation-error' || d.code === 'yaml-validation-error');

    try {
      await waitFor(() => validationCodes().length === 0, 10_000, 'validation disabled');
      await setSetting('comments.validation.enabled', true);
      const diagnostics = await waitFor(() => (validationCodes().length > 0 ? validationCodes() : undefined), 10_000, 'JSON validation diagnostic');
      assert.equal(diagnostics.length, 1);
      assert.equal(document.getText(diagnostics[0].range), '}');
      assert.equal(diagnostics[0].severity, vscode.DiagnosticSeverity.Error);
    } finally {
      await setSetting('comments.validation.enabled', undefined);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    await waitFor(() => validationCodes().length === 0, 10_000, 'validation diagnostic cleared');
  });

  it('copies tagged bodies and requires confirmation before extracting or overwriting files', async () => {
    const editor = await open('multi-language-comments.cs');
    const block = api.comments.getScan(editor.document).blocks.find((candidate) => candidate.language === 'yaml');
    assert.ok(block);
    editor.selection = new vscode.Selection(
      editor.document.positionAt(block.bodyStartOffset + 1),
      editor.document.positionAt(block.bodyStartOffset + 1),
    );
    const suffix = `${process.pid}-${Date.now()}`;
    const cancelledTarget = vscode.Uri.file(path.join(os.tmpdir(), `tagged-comment-cancel-${suffix}.yaml`));
    const target = vscode.Uri.file(path.join(os.tmpdir(), `tagged-comment-extract-${suffix}.yaml`));
    const expected = block.normalizedBody + (/(?:\r\n|\r|\n)$/.test(block.rawBody) ? '\n' : '');

    try {
      ui.saveFile = () => cancelledTarget;
      await vscode.commands.executeCommand('dotnetFileApps.extractTaggedComment', editor.document.uri);
      await assert.rejects(fs.stat(cancelledTarget.fsPath));

      await fs.writeFile(target.fsPath, 'existing content');
      ui.saveFile = () => target;
      await vscode.commands.executeCommand('dotnetFileApps.extractTaggedComment', editor.document.uri);
      assert.equal(await fs.readFile(target.fsPath, 'utf8'), 'existing content');

      ui.respond = (message) => (message.items.includes('Overwrite and Extract') ? 'Overwrite and Extract' : undefined);
      await vscode.commands.executeCommand('dotnetFileApps.extractTaggedComment', editor.document.uri);
      assert.equal(await fs.readFile(target.fsPath, 'utf8'), expected);

      await vscode.commands.executeCommand('dotnetFileApps.copyTaggedComment', editor.document.uri);
      assert.equal(await vscode.env.clipboard.readText(), block.rawBody);
    } finally {
      await fs.rm(cancelledTarget.fsPath, { force: true });
      await fs.rm(target.fsPath, { force: true });
    }
  });

  it('turns everything off when comments are disabled', async () => {
    const { document } = await open('tagged-markdown.cs');
    await setSetting('comments.enabled', false);
    try {
      await waitFor(() => api.comments.hasTaggedComments(document.uri) === false || undefined, 10_000, 'context cleared');
      assert.equal(await hoverAt(document, 'validates **inventory**'), '');
      await vscode.commands.executeCommand('dotnetFileApps.previewComments', fixtureUri('ordinary-comments.cs'));
      assert.ok(
        ui.messages.some((m) => m.message.includes('comments.enabled')),
        `expected a disabled notice, got ${JSON.stringify(ui.messages)}`,
      );
    } finally {
      await setSetting('comments.enabled', undefined);
    }
    await waitFor(() => api.comments.hasTaggedComments(document.uri) || undefined, 10_000, 'tagged comments re-enabled');
  });

  it('never modifies the source files', async () => {
    for (const [name, original] of originals) {
      assert.equal(await fs.readFile(fixtureUri(name).fsPath, 'utf8'), original, `${name} changed on disk`);
    }
    for (const document of vscode.workspace.textDocuments) {
      if (originals.has(document.uri.path.split('/').pop() ?? '')) {
        assert.equal(document.isDirty, false, `${document.uri.fsPath} is dirty`);
      }
    }
  });
});
