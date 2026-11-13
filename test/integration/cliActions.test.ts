import * as assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ToolkitApi } from '../../src/extension';
import { activateExtension, fixtureUri, UiStub, waitFor, workspaceDir } from './helpers';

interface Outcome {
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
}

function assertSucceeded(outcome: Outcome | undefined, label?: string): void {
  assert.deepEqual({ exitCode: outcome?.exitCode, cancelled: outcome?.cancelled }, { exitCode: 0, cancelled: false }, label);
}

describe('CLI actions (requires .NET SDK 10+)', function () {
  this.timeout(300_000);
  const ui = new UiStub();
  let api: ToolkitApi;

  before(async () => {
    api = await activateExtension();
    ui.install();
  });

  after(() => ui.restore());

  beforeEach(() => ui.reset());

  afterEach(function () {
    if (this.currentTest?.state === 'failed') {
      console.log('Recorded messages:', JSON.stringify(ui.messages, undefined, 2));
    }
  });

  it('recognizes a file with #: directives and rejects an ordinary C# file', async () => {
    const hello = fixtureUri('hello.cs');
    const library = fixtureUri('library.cs');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(library));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(hello));
    await waitFor(() => api.detector.isFileApp(hello), 10_000, 'hello.cs detection');
    await waitFor(() => api.detector.isFileApp(library) === false || undefined, 10_000, 'library.cs detection');
  });

  it('asks before running a file that is not a file-based app and does nothing when dismissed', async () => {
    const outcome = await vscode.commands.executeCommand<Outcome | undefined>('dotnetFileApps.runFile', fixtureUri('library.cs'));
    assert.equal(outcome, undefined);
    const prompt = ui.messages.find((m) => m.modal);
    assert.ok(prompt?.message.includes('not recognized'), 'expected a modal recognition prompt');
    assert.deepEqual(ui.errors(), []);
  });

  it('restores, builds and cleans a file-based app', async () => {
    for (const command of ['dotnetFileApps.restore', 'dotnetFileApps.build', 'dotnetFileApps.clean']) {
      const outcome = await vscode.commands.executeCommand<Outcome>(command, fixtureUri('hello.cs'));
      assertSucceeded(outcome, command);
    }
    assert.deepEqual(ui.errors(), []);
  });

  it('resolves dotnet-file-app tasks from tasks.json', async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: 'dotnet-file-app' });
    const task = tasks.find((t) => t.name === 'Build hello.cs (tasks.json)');
    assert.ok(task, `configured task not found among: ${tasks.map((t) => t.name).join(', ')}`);
    const exitCode = new Promise<number | undefined>((resolve) => {
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution.task.name === task.name) {
          sub.dispose();
          resolve(e.exitCode);
        }
      });
    });
    await vscode.tasks.executeTask(task);
    assert.equal(await exitCode, 0);
  });

  it('runs a file and passes arguments as discrete process arguments', async () => {
    const outFile = path.join(workspaceDir(), 'args out.txt');
    const expected = ['plain', 'with space', 'quote"inside', '${workspaceFolder}', ''];
    ui.input = () => `"${outFile}" plain "with space" 'quote"inside' '\${workspaceFolder}' ""`;
    const outcome = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.runWithArgs', fixtureUri('args-echo.cs'));
    assertSucceeded(outcome);
    const written = (await fs.readFile(outFile, 'utf8')).split(/\r?\n/);
    assert.deepEqual(written.slice(0, expected.length), expected);
  });

  it('runs a file through a VS Code task', async () => {
    const outcome = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.runFile', fixtureUri('hello.cs'));
    assertSucceeded(outcome);
  });

  it('runs with a profile from the higher-priority launchSettings.json file', async () => {
    const appDir = path.join(workspaceDir(), 'launch-profile-app');
    const propertiesDir = path.join(appDir, 'Properties');
    const appFile = path.join(appDir, 'launch-profile-app.cs');
    await fs.mkdir(propertiesDir, { recursive: true });
    await fs.writeFile(appFile, '#:property PublishAot=false\nConsole.WriteLine("profile");\n');
    await fs.writeFile(
      path.join(appDir, 'launch-profile-app.run.json'),
      '{"profiles":{"FromRunFile":{"commandName":"Project"}}}',
    );
    await fs.writeFile(
      path.join(propertiesDir, 'launchSettings.json'),
      '{\n  // The conventional file takes precedence.\n  "profiles": { "FromLaunchSettings": { "commandName": "Project" }, },\n}',
    );
    try {
      ui.pick = (items) => items.find((item) => item.label === 'FromLaunchSettings');
      const outcome = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.runWithProfile', vscode.Uri.file(appFile));
      assertSucceeded(outcome);
      assert.deepEqual(ui.errors(), []);
    } finally {
      await fs.rm(appDir, { recursive: true, force: true });
    }
  });

  it('packs a file-based app as a tool', async () => {
    const outcome = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.packAsTool', fixtureUri('hello.cs'));
    assertSucceeded(outcome);
    assert.deepEqual(ui.errors(), []);
  });

  it('requires explicit confirmation before cleaning the file-app cache', async () => {
    ui.input = () => '30';
    const outcome = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.cleanFileAppCache', fixtureUri('hello.cs'));
    assert.equal(outcome, undefined);
    assert.ok(ui.messages.some((message) => message.modal && message.message.toLowerCase().includes('clean file-based app cache')));
    assert.deepEqual(ui.errors(), []);
  });

  it('does not clean the global cache while another file-based app is running', async () => {
    const sleep = fixtureUri('sleep.cs');
    const running = vscode.commands.executeCommand<Outcome>('dotnetFileApps.runFile', sleep);
    try {
      await waitFor(() => api.runner.getRunning(sleep), 10_000, 'sleep.cs to start');
      ui.input = () => '0';
      ui.respond = (message) => (message.modal && message.items.includes('Clean Cache') ? 'Clean Cache' : undefined);
      const outcome = await vscode.commands.executeCommand<Outcome>(
        'dotnetFileApps.cleanFileAppCache',
        fixtureUri('hello.cs'),
      );
      assert.equal(outcome, undefined);
      assert.ok(ui.errors().some((message) => message.message.includes('Cannot start Clean File-Based App Cache')));
    } finally {
      await api.runner.stop(sleep);
      assert.equal((await running).cancelled, true);
    }
  });

  it('allows only one operation per file and can stop the running one', async () => {
    const sleep = fixtureUri('sleep.cs');
    const running = vscode.commands.executeCommand<Outcome>('dotnetFileApps.runFile', sleep);
    await waitFor(() => api.runner.getRunning(sleep), 10_000, 'sleep.cs to start');
    ui.respond = (m) => (m.items.includes('Stop and Continue') ? 'Stop and Continue' : undefined);
    const build = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.build', sleep);
    assertSucceeded(build);
    assert.equal((await running).cancelled, true);
  });

  it('publishes to the default output folder after confirmation', async () => {
    ui.pick = (items) => items[0];
    ui.respond = (m) => (m.modal && m.items.includes('Publish') ? 'Publish' : undefined);
    const outcome = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.publish', fixtureUri('hello.cs'));
    assertSucceeded(outcome);
    assert.ok(existsSync(path.join(workspaceDir(), 'artifacts', 'hello', 'hello.dll')));
    const confirm = ui.messages.find((m) => m.modal);
    assert.ok(confirm && !confirm.message.includes('Native AOT'), 'PublishAot=false must suppress the AOT warning');
  });

  it('converts to a project, keeps the original and never reuses an existing folder', async () => {
    const hello = fixtureUri('hello.cs');
    const original = await fs.readFile(hello.fsPath, 'utf8');
    const originalMtime = (await fs.stat(hello.fsPath)).mtimeMs;

    ui.respond = (m) => (m.modal && m.items.includes('Convert') ? 'Convert' : undefined);
    const first = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.convertToProject', hello);
    assertSucceeded(first);
    assert.ok(existsSync(path.join(workspaceDir(), 'hello', 'hello.csproj')));
    assert.equal(await fs.readFile(hello.fsPath, 'utf8'), original);

    ui.reset();
    ui.respond = (m) => (m.modal && m.items.includes('Choose Another Folder…') ? 'Choose Another Folder…' : undefined);
    ui.input = (options) => options?.value;
    const second = await vscode.commands.executeCommand<Outcome>('dotnetFileApps.convertToProject', hello);
    assertSucceeded(second);
    assert.ok(ui.messages.some((m) => m.modal && m.message.includes('already exists')));
    assert.ok(existsSync(path.join(workspaceDir(), 'hello-project', 'hello.csproj')));
    assert.equal(await fs.readFile(hello.fsPath, 'utf8'), original);
    // An unchanged mtime proves the CLI itself kept the file (the extension's restore fallback was not needed).
    assert.equal((await fs.stat(hello.fsPath)).mtimeMs, originalMtime);
  });
});
