import * as path from 'node:path';
import * as vscode from 'vscode';
import { COMMANDS, registerCommand, type ToolkitServices } from '../commands/registerCommands';
import { resolveTargetUri } from '../commands/target';

interface ActionItem extends vscode.QuickPickItem {
  readonly command?: string;
}

function item(icon: string, label: string, command: string, description?: string): ActionItem {
  return { label: `$(${icon}) ${label}`, description, command };
}

function separator(label: string): ActionItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

export function buildActionItems(isFileApp: boolean, running: string | undefined): ActionItem[] {
  return [
    separator(vscode.l10n.t('Run')),
    item('play', vscode.l10n.t('Run File'), COMMANDS.runFile, 'dotnet run --file'),
    item('debug-console', vscode.l10n.t('Run with Arguments…'), COMMANDS.runWithArgs, 'dotnet run --file … -- <args>'),
    item('debug-start', vscode.l10n.t('Run with Launch Profile…'), COMMANDS.runWithProfile, 'dotnet run --launch-profile'),
    separator(vscode.l10n.t('Build')),
    item('cloud-download', vscode.l10n.t('Restore'), COMMANDS.restore, 'dotnet restore'),
    item('tools', vscode.l10n.t('Build'), COMMANDS.build, 'dotnet build'),
    item('trash', vscode.l10n.t('Clean File'), COMMANDS.clean, 'dotnet clean'),
    item('package', vscode.l10n.t('Publish Executable…'), COMMANDS.publish, 'dotnet publish'),
    item('package', vscode.l10n.t('Pack as Tool'), COMMANDS.packAsTool, 'dotnet pack'),
    item('clear-all', vscode.l10n.t('Clean File-Based App Cache…'), COMMANDS.cleanFileAppCache, 'dotnet clean file-based-apps'),
    item('edit', vscode.l10n.t('Manage File-Based App Directives…'), COMMANDS.manageDirectives),
    item('references', vscode.l10n.t('Manage Project References…'), COMMANDS.manageProjectReferences, 'dotnet reference --file'),
    item('symbol-operator', vscode.l10n.t('Format File…'), COMMANDS.formatFile, 'dotnet format <file.cs>'),
    item('project', vscode.l10n.t('Convert to Project…'), COMMANDS.convertToProject, 'dotnet project convert'),
    separator(vscode.l10n.t('Comments')),
    item('open-preview', vscode.l10n.t('Preview Tagged Comments'), COMMANDS.previewComments),
    item('copy', vscode.l10n.t('Copy Tagged Comment Body'), COMMANDS.copyTaggedComment),
    item('export', vscode.l10n.t('Extract Tagged Comment to File…'), COMMANDS.extractTaggedComment),
    separator(vscode.l10n.t('Toolkit')),
    item('versions', vscode.l10n.t('Check .NET SDK'), COMMANDS.checkSdk, 'dotnet --version'),
    isFileApp
      ? item('circle-slash', vscode.l10n.t('Disable File Apps Toolkit for This File'), COMMANDS.disableForFile)
      : item('check', vscode.l10n.t('Enable File Apps Toolkit for This File'), COMMANDS.enableForFile),
    item('book', vscode.l10n.t('Open File-Based Apps Documentation'), COMMANDS.openDocs),
    item('output', vscode.l10n.t('Show Logs'), COMMANDS.showLogs),
  ].map((i) =>
    running && i.command === COMMANDS.runFile ? { ...i, detail: vscode.l10n.t('"{0}" is running', running) } : i,
  );
}

export function registerActionPicker(services: ToolkitServices): void {
  registerCommand(services, COMMANDS.showActions, async (arg) => {
    const uri = resolveTargetUri(arg);
    const isFileApp = services.detector.isFileApp(uri) ?? false;
    const running = uri.scheme === 'file' ? services.runner.getRunning(uri)?.name : undefined;
    const picked = await vscode.window.showQuickPick(buildActionItems(isFileApp, running), {
      title: vscode.l10n.t('.NET File Apps: {0}', path.basename(uri.fsPath || uri.path)),
      placeHolder: vscode.l10n.t('Select an action'),
      matchOnDescription: true,
    });
    if (picked?.command) {
      return vscode.commands.executeCommand(picked.command, uri);
    }
    return undefined;
  });
}
