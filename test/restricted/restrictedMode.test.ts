import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ToolkitApi } from '../../src/extension';
import { activateExtension, fixtureUri, UiStub, waitFor, workspaceDir } from '../integration/helpers';

const SDK_COMMANDS = [
  'dotnetFileApps.runFile',
  'dotnetFileApps.runWithArgs',
  'dotnetFileApps.runWithProfile',
  'dotnetFileApps.restore',
  'dotnetFileApps.build',
  'dotnetFileApps.clean',
  'dotnetFileApps.publish',
  'dotnetFileApps.packAsTool',
  'dotnetFileApps.cleanFileAppCache',
  'dotnetFileApps.manageProjectReferences',
  'dotnetFileApps.formatFile',
  'dotnetFileApps.convertToProject',
  'dotnetFileApps.checkSdk',
];

const IMAGE_FILE = 'remote-image.cs';

describe('Restricted Mode', function () {
  this.timeout(120_000);
  const ui = new UiStub();
  let api: ToolkitApi;

  before(async () => {
    assert.equal(vscode.workspace.isTrusted, false, 'this suite must run in an untrusted workspace');
    await fs.writeFile(
      fixtureUri(IMAGE_FILE).fsPath,
      ['#:property PublishAot=false', '', '/*markdown', '# Remote image', '', '![logo](https://example.com/logo.png)', '*/', '', 'Console.WriteLine("image");', ''].join('\n'),
    );
    api = await activateExtension();
    ui.install();
  });

  after(async () => {
    ui.restore();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  beforeEach(() => ui.reset());

  it('ignores workspace values of restricted settings', async () => {
    const raw = JSON.parse(await fs.readFile(path.join(workspaceDir(), '.vscode', 'settings.json'), 'utf8'));
    assert.ok(raw['dotnetFileAppsToolkit.dotnetPath'], 'the workspace must set dotnetPath for this test');
    const config = vscode.workspace.getConfiguration('dotnetFileAppsToolkit');
    assert.equal(config.get('dotnetPath'), 'dotnet');
    assert.deepEqual(config.get('run.args'), []);
    assert.equal(config.get('codeLens.enabled'), true, 'unrestricted workspace settings still apply');
  });

  it('refuses every command that starts the .NET SDK', async () => {
    const uri = fixtureUri('hello.cs');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    assert.equal((await api.detector.detect(uri)).decision.isFileApp, true, 'detection still works');
    const filesBefore = (await fs.readdir(workspaceDir())).sort();

    for (const command of SDK_COMMANDS) {
      ui.reset();
      assert.equal(await vscode.commands.executeCommand(command, uri), undefined, command);
      assert.deepEqual(ui.errors(), [], `${command} must not report an error`);
      const warnings = ui.messages.filter((m) => m.kind === 'warning');
      assert.equal(warnings.length, 1, `${command}: ${JSON.stringify(ui.messages)}`);
      assert.match(warnings[0].message, /Trust the workspace to use it\./, command);
      assert.ok(warnings[0].items.includes('Manage Workspace Trust'), command);
    }

    assert.equal(vscode.tasks.taskExecutions.length, 0, 'no task was started');
    assert.equal(vscode.window.terminals.length, 0, 'no terminal was created');
    assert.equal(api.runner.getRunning(uri), undefined);
    assert.deepEqual((await fs.readdir(workspaceDir())).sort(), filesBefore, 'no files were created');
  });

  it('renders Markdown without loading remote images', async () => {
    const uri = fixtureUri(IMAGE_FILE);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await waitFor(() => api.comments.hasTaggedComments(uri), 10_000, 'tagged comment detection');

    const position = document.positionAt(document.getText().indexOf('# Remote image') + 1);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position);
    const hover = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : c.value))
      .join('\n');
    assert.match(hover, /# Remote image/);
    assert.match(hover, /\\!\[logo\]\(https:\/\/example\.com\/logo\.png\)/, 'image syntax is escaped in the hover');

    await vscode.commands.executeCommand('dotnetFileApps.previewComments', uri);
    const preview = await waitFor(() => api.previews.get(uri), 10_000, 'preview panel');
    const snapshot = await waitFor(() => preview.snapshot, 10_000, 'preview snapshot');
    assert.doesNotMatch(snapshot.html, /<img/i);
    assert.match(snapshot.html, /md-image-blocked/);
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(preview.panel.webview.html)?.[1];
    assert.ok(csp, 'the preview page has a CSP');
    const imgSources = /(?:^|;)\s*img-src([^;]*)/.exec(csp)?.[1].trim().split(/\s+/) ?? [];
    assert.ok(!imgSources.includes('https:'), `img-src must not allow any https origin: ${imgSources.join(' ')}`);
  });
});
