import * as assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ToolkitApi } from '../../src/extension';
import { activateExtension, EXTENSION_ID, fixtureUri, restoreDocumentFromDisk, UiStub, waitFor, workspaceDir } from './helpers';

interface Outcome {
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
}

interface MenuItem {
  readonly command: string;
  readonly when?: string;
}

const FILE_APP_KEY = 'dotnetFileApps.fileAppUris';
const TAGGED_KEY = 'dotnetFileApps.taggedCommentUris';

/** Records `setContext` calls so tests can check the values that drive the editor-title `when` clauses. */
class ContextKeySpy {
  readonly values = new Map<string, unknown>();
  private original: typeof vscode.commands.executeCommand | undefined;

  install(): void {
    const original = vscode.commands.executeCommand;
    this.original = original;
    (vscode.commands as { executeCommand: unknown }).executeCommand = (id: string, ...args: unknown[]) => {
      if (id === 'setContext' && typeof args[0] === 'string') {
        this.values.set(args[0], args[1]);
      }
      return original.call(vscode.commands, id, ...args);
    };
  }

  restore(): void {
    if (this.original) {
      (vscode.commands as { executeCommand: unknown }).executeCommand = this.original;
    }
  }

  includes(key: string, uri: vscode.Uri): true | undefined {
    const value = this.values.get(key);
    return Array.isArray(value) && value.includes(uri.toString()) ? true : undefined;
  }
}

async function show(uri: vscode.Uri, column = vscode.ViewColumn.One): Promise<vscode.TextEditor> {
  return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), column);
}

async function closeAll(api: ToolkitApi, uris: readonly vscode.Uri[]): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => uris.every((u) => !api.previews.get(u)) || undefined, 10_000, 'previews to close');
}

describe('Editor integration', function () {
  this.timeout(300_000);
  const ui = new UiStub();
  const contextKeys = new ContextKeySpy();
  let api: ToolkitApi;
  const markdownUri = () => fixtureUri('tagged-markdown.cs');
  const yamlUri = () => fixtureUri('tagged-yaml-json-sql.cs');
  const multiUri = () => fixtureUri('multi-language-comments.cs');

  before(async () => {
    api = await activateExtension();
    ui.install();
    contextKeys.install();
    await closeAll(api, [markdownUri(), yamlUri(), multiUri()]);
  });

  after(async () => {
    contextKeys.restore();
    ui.restore();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  beforeEach(() => ui.reset());

  afterEach(function () {
    if (this.currentTest?.state === 'failed') {
      console.log('Recorded messages:', JSON.stringify(ui.messages, undefined, 2));
    }
  });

  it('registers every contributed command and gates editor actions per file', async () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
      contributes: { commands: { command: string }[]; menus: Record<string, MenuItem[]> };
    };
    const registered = new Set(await vscode.commands.getCommands(true));
    const contributed = pkg.contributes.commands.map((c) => c.command);
    assert.deepEqual(
      contributed.filter((id) => !registered.has(id)),
      [],
      'contributed commands without a registration',
    );

    for (const [menu, items] of Object.entries(pkg.contributes.menus)) {
      for (const item of items) {
        assert.ok(contributed.includes(item.command), `${menu} references unknown command ${item.command}`);
        if (menu === 'editor/title' || menu === 'editor/context') {
          assert.match(item.when ?? '', /config\.dotnetFileAppsToolkit\.enabled/, `${menu} ${item.command}`);
          const key = item.command === 'dotnetFileApps.previewComments' ? TAGGED_KEY : FILE_APP_KEY;
          assert.ok(item.when?.includes(`resource in ${key}`), `${menu} ${item.command} must be gated by ${key}`);
        }
      }
    }
  });

  it('runs commands on the URI argument and falls back to the active editor', async () => {
    await show(markdownUri());
    await vscode.commands.executeCommand('dotnetFileApps.previewComments', yamlUri());
    const yamlPreview = await waitFor(() => api.previews.get(yamlUri())?.snapshot, 10_000, 'YAML preview');
    assert.deepEqual(
      yamlPreview.blocks.map((b) => b.language),
      ['yaml', 'json', 'sql'],
    );
    assert.equal(api.previews.get(markdownUri()), undefined, 'the active editor must not be previewed when a URI is given');

    await show(markdownUri());
    await vscode.commands.executeCommand('dotnetFileApps.previewComments');
    const mdPreview = await waitFor(() => api.previews.get(markdownUri())?.snapshot, 10_000, 'Markdown preview');
    assert.equal(mdPreview.blocks[0].language, 'markdown');

    await show(vscode.Uri.file(path.join(workspaceDir(), '.vscode', 'tasks.json')));
    await vscode.commands.executeCommand('dotnetFileApps.previewComments');
    assert.ok(
      ui.messages.some((m) => m.message.includes('only available for C#')),
      'a non-C# active editor must be rejected',
    );
    assert.deepEqual(ui.errors(), []);
    await closeAll(api, [markdownUri(), yamlUri()]);
  });

  describe('paths with spaces, Unicode and shell metacharacters', () => {
    const names = ['hello world.cs', '日本語 檔案.cs', 'odd & mkdir pwned & (1) !v! ^x.cs'];
    const dir = () => path.join(workspaceDir(), 'dir with spaces');
    const uriOf = (name: string) => vscode.Uri.file(path.join(dir(), name));
    const sources = new Map<string, string>();

    before(async () => {
      await fs.mkdir(dir(), { recursive: true });
      for (const name of names) {
        const text = [
          '#:property PublishAot=false',
          '',
          '/*markdown',
          `Notes for **${name}**.`,
          '*/',
          'if (args.Length > 0) File.WriteAllText(args[0], "ran");',
          'Console.WriteLine("ok");',
          '',
        ].join('\n');
        await fs.writeFile(uriOf(name).fsPath, text, 'utf8');
        sources.set(name, text);
      }
    });

    after(() => closeAll(api, names.map(uriOf)));

    it('detects, previews and publishes context keys for each file', async () => {
      for (const name of names) {
        const uri = uriOf(name);
        await show(uri);
        await waitFor(() => api.detector.isFileApp(uri), 10_000, `${name} detection`);
        await waitFor(() => contextKeys.includes(FILE_APP_KEY, uri), 10_000, `${name} in ${FILE_APP_KEY}`);
        await waitFor(() => contextKeys.includes(TAGGED_KEY, uri), 10_000, `${name} in ${TAGGED_KEY}`);
        await vscode.commands.executeCommand('dotnetFileApps.previewComments', uri);
        const snapshot = await waitFor(() => api.previews.get(uri)?.snapshot, 10_000, `${name} preview`);
        assert.ok(snapshot.html.includes('<strong>'), `${name} preview should render Markdown`);
      }
      assert.deepEqual(ui.errors(), []);
    });

    it('builds and runs each file without shell interpretation', async () => {
      for (const name of names) {
        const outcome = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.build', uriOf(name));
        assert.deepEqual({ exitCode: outcome?.exitCode, cancelled: outcome?.cancelled }, { exitCode: 0, cancelled: false }, name);
      }

      const marker = path.join(dir(), 'ran marker.txt');
      ui.input = () => `"${marker}"`;
      const run = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.runWithArgs', uriOf(names[2]));
      assert.deepEqual({ exitCode: run?.exitCode, cancelled: run?.cancelled }, { exitCode: 0, cancelled: false });
      assert.equal(await fs.readFile(marker, 'utf8'), 'ran');

      for (const where of [workspaceDir(), dir(), process.cwd()]) {
        assert.equal(existsSync(path.join(where, 'pwned')), false, `"pwned" was created in ${where}`);
      }
      for (const name of names) {
        assert.equal(await fs.readFile(uriOf(name).fsPath, 'utf8'), sources.get(name), `${name} was modified`);
      }
      assert.deepEqual(ui.errors(), []);
    });
  });

  it('keeps decorations and previews separate for editors side by side', async () => {
    const md = await show(markdownUri(), vscode.ViewColumn.One);
    const multi = await show(multiUri(), vscode.ViewColumn.Two);
    assert.notEqual(md.viewColumn, multi.viewColumn);

    const decorations = (uri: vscode.Uri) => api.markdownDecorations.applied.get(uri.toString());
    const mdBold = await waitFor(() => decorations(markdownUri())?.bold.length, 10_000, 'Markdown decorations');
    const multiCode = await waitFor(() => decorations(multiUri())?.code.length, 10_000, 'multi-language decorations');
    const multiBold = decorations(multiUri())?.bold.length ?? 0;

    await vscode.commands.executeCommand('dotnetFileApps.previewComments', markdownUri());
    await vscode.commands.executeCommand('dotnetFileApps.previewComments', multiUri());
    const mdPreview = await waitFor(() => api.previews.get(markdownUri()), 10_000, 'Markdown preview');
    const multiPreview = await waitFor(() => api.previews.get(multiUri()), 10_000, 'multi-language preview');
    assert.notEqual(mdPreview, multiPreview);
    const mdBefore = await waitFor(() => mdPreview.snapshot, 10_000, 'Markdown snapshot');
    const multiBlocks = (await waitFor(() => multiPreview.snapshot, 10_000, 'multi-language snapshot')).blocks.length;

    const edited = await show(multiUri(), vscode.ViewColumn.Two);
    await edited.edit((b) => b.insert(new vscode.Position(edited.document.lineCount, 0), '\n/*md\nAdded **bold** text.\n*/\n'));
    try {
      await waitFor(
        () => (multiPreview.snapshot?.blocks.length === multiBlocks + 1 ? true : undefined),
        10_000,
        'multi-language preview refresh',
      );
      await waitFor(() => decorations(multiUri())?.bold.length === multiBold + 1 || undefined, 10_000, 'multi-language bold decoration');
      assert.equal(mdPreview.snapshot?.version, mdBefore.version, 'the other document version must not change');
      assert.equal(mdPreview.snapshot?.html, mdBefore.html, 'the other preview content must remain unchanged');
      assert.equal(decorations(markdownUri())?.bold.length, mdBold);
      assert.equal(md.document.isDirty, false);
    } finally {
      await restoreDocumentFromDisk(edited.document);
    }
    await waitFor(() => (multiPreview.snapshot?.blocks.length === multiBlocks ? true : undefined), 10_000, 'preview after revert');
    await waitFor(() => decorations(multiUri())?.bold.length === multiBold || undefined, 10_000, 'decorations after revert');
    assert.equal(decorations(multiUri())?.code.length, multiCode);
  });
});
