import * as vscode from 'vscode';
import { COMMANDS, registerCommand, registerCoreCommands, type ToolkitServices } from './commands/registerCommands';
import { UserFacingError } from './core/errors';
import { Logger } from './core/logging';
import { FileAppDetector } from './dotnet/fileAppDetector';
import { SdkService } from './dotnet/sdkService';

export interface ToolkitApi {
  readonly detector: FileAppDetector;
}

export function activate(context: vscode.ExtensionContext): ToolkitApi {
  const logger = new Logger('.NET File Apps');
  context.subscriptions.push(logger);
  logger.info(`Activating .NET File Apps Toolkit ${context.extension.packageJSON.version ?? ''}`);

  const sdk = new SdkService(logger);
  const detector = new FileAppDetector(context.workspaceState, logger);
  context.subscriptions.push(sdk, detector);

  const services: ToolkitServices = { context, logger, sdk, detector };
  registerCoreCommands(services);

  const notYetAvailable = () => {
    throw new UserFacingError(vscode.l10n.t('This command is not available yet.'), [], 'info');
  };
  for (const id of [
    COMMANDS.runFile,
    COMMANDS.runWithArgs,
    COMMANDS.restore,
    COMMANDS.build,
    COMMANDS.clean,
    COMMANDS.publish,
    COMMANDS.convertToProject,
    COMMANDS.showActions,
    COMMANDS.previewComments,
  ]) {
    registerCommand(services, id, notYetAvailable);
  }

  return { detector };
}

export function deactivate(): void {
  // Disposables registered on the extension context are released by VS Code.
}
