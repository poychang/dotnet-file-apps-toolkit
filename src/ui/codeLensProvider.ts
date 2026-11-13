import * as vscode from 'vscode';
import { getSettings } from '../core/settings';
import type { FileAppDetector } from '../dotnet/fileAppDetector';
import { COMMANDS } from '../commands/registerCommands';

export class FileAppCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[];

  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor(private readonly detector: FileAppDetector) {
    this.disposables = [
      this.changeEmitter,
      detector.onDidChange(() => this.changeEmitter.fire()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.languageId === 'csharp') {
          this.changeEmitter.fire();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('dotnetFileAppsToolkit.enabled') ||
          event.affectsConfiguration('dotnetFileAppsToolkit.codeLens.enabled') ||
          event.affectsConfiguration('dotnetFileAppsToolkit.fileDetection')
        ) {
          this.changeEmitter.fire();
        }
      }),
    ];
  }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const settings = getSettings(document.uri);
    if (
      token.isCancellationRequested ||
      document.languageId !== 'csharp' ||
      !settings.enabled ||
      !settings.codeLens.enabled ||
      !(await this.detector.detect(document.uri)).decision.isFileApp ||
      token.isCancellationRequested
    ) {
      return [];
    }

    const position = new vscode.Position(0, 0);
    const range = new vscode.Range(position, position);
    return [
      new vscode.CodeLens(range, {
        title: vscode.l10n.t('Run File'),
        command: COMMANDS.runFile,
        arguments: [document.uri],
      }),
      new vscode.CodeLens(range, {
        title: vscode.l10n.t('More Actions…'),
        command: COMMANDS.showActions,
        arguments: [document.uri],
      }),
    ];
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

export function registerFileAppCodeLensProvider(detector: FileAppDetector): vscode.Disposable {
  const provider = new FileAppCodeLensProvider(detector);
  return vscode.Disposable.from(
    vscode.languages.registerCodeLensProvider({ language: 'csharp', scheme: 'file' }, provider),
    provider,
  );
}
