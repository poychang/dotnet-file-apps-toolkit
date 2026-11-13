import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { reportError, UserFacingError } from '../core/errors';
import type { Logger } from '../core/logging';
import type { DotnetCommandRunner } from '../dotnet/commandRunner';
import type { FileAppDetector } from '../dotnet/fileAppDetector';
import { FILE_APPS_DOCS_URL, sdkProbeError, type SdkService } from '../dotnet/sdkService';
import { resolveTargetUri, validateLocalCSharpFile } from './target';
import type { TaggedCommentService } from '../comments/taggedCommentService';

export interface ToolkitServices {
  readonly context: vscode.ExtensionContext;
  readonly logger: Logger;
  readonly sdk: SdkService;
  readonly detector: FileAppDetector;
  readonly runner: DotnetCommandRunner;
  readonly comments: TaggedCommentService;
}

export const COMMANDS = {
  runFile: 'dotnetFileApps.runFile',
  runWithArgs: 'dotnetFileApps.runWithArgs',
  restore: 'dotnetFileApps.restore',
  build: 'dotnetFileApps.build',
  clean: 'dotnetFileApps.clean',
  publish: 'dotnetFileApps.publish',
  convertToProject: 'dotnetFileApps.convertToProject',
  previewComments: 'dotnetFileApps.previewComments',
  copyTaggedComment: 'dotnetFileApps.copyTaggedComment',
  extractTaggedComment: 'dotnetFileApps.extractTaggedComment',
  showActions: 'dotnetFileApps.showActions',
  checkSdk: 'dotnetFileApps.checkSdk',
  openDocs: 'dotnetFileApps.openDocs',
  enableForFile: 'dotnetFileApps.enableForFile',
  disableForFile: 'dotnetFileApps.disableForFile',
  showLogs: 'dotnetFileApps.showLogs',
} as const;

export type CommandHandler = (arg?: unknown) => unknown;

export function registerCommand(services: ToolkitServices, id: string, handler: CommandHandler): void {
  services.context.subscriptions.push(
    vscode.commands.registerCommand(id, async (arg?: unknown) => {
      try {
        services.logger.debug(`Command ${id}`);
        return await handler(arg);
      } catch (err) {
        await reportError(err, services.logger);
        return undefined;
      }
    }),
  );
}

export function registerCoreCommands(services: ToolkitServices): void {
  const { logger, sdk, detector } = services;

  registerCommand(services, COMMANDS.checkSdk, async (arg) => {
    let cwd: string;
    let scope: vscode.Uri | undefined;
    let label: string;
    try {
      const uri = await validateLocalCSharpFile(resolveTargetUri(arg));
      cwd = path.dirname(uri.fsPath);
      scope = uri;
      label = path.basename(uri.fsPath);
    } catch {
      const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
      cwd = folder?.uri.fsPath ?? os.homedir();
      scope = folder?.uri;
      label = cwd;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Checking .NET SDK…') },
      () => sdk.probeDirectory(cwd, scope, { force: true }),
    );
    if (!result.ok) {
      throw sdkProbeError(result);
    }
    const caps = result.capabilities;
    const features = [
      caps.includeDirective ? '#:include' : undefined,
      caps.referenceFileCommands ? 'dotnet reference --file' : undefined,
    ].filter(Boolean);
    const message = vscode.l10n.t(
      '.NET SDK {0} is used for {1}. File-based apps are supported{2}.',
      result.version.raw,
      label,
      features.length > 0 ? ` (+ ${features.join(', ')})` : '',
    );
    logger.info(message);
    if (caps.prerelease) {
      void vscode.window.showWarningMessage(
        `${message} ${vscode.l10n.t('This is a prerelease SDK; some features may be unavailable.')}`,
      );
    } else {
      void vscode.window.showInformationMessage(message);
    }
  });

  registerCommand(services, COMMANDS.openDocs, () => vscode.env.openExternal(vscode.Uri.parse(FILE_APPS_DOCS_URL)));

  registerCommand(services, COMMANDS.showLogs, () => logger.show(false));

  registerCommand(services, COMMANDS.enableForFile, async (arg) => {
    const uri = await validateLocalCSharpFile(resolveTargetUri(arg));
    await detector.setOverride(uri, 'enabled');
    void vscode.window.showInformationMessage(
      vscode.l10n.t('.NET File Apps Toolkit is enabled for {0}.', path.basename(uri.fsPath)),
    );
  });

  registerCommand(services, COMMANDS.disableForFile, async (arg) => {
    const uri = resolveTargetUri(arg);
    if (uri.scheme !== 'file') {
      throw new UserFacingError(vscode.l10n.t('Only local .cs files can be disabled.'), [], 'info');
    }
    await detector.setOverride(uri, 'disabled');
    void vscode.window.showInformationMessage(
      vscode.l10n.t('.NET File Apps Toolkit is disabled for {0}. Use "Enable File Apps Toolkit for This File" to undo.', path.basename(uri.fsPath)),
    );
  });
}
