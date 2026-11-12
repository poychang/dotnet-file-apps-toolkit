import * as vscode from 'vscode';
import { registerActionCommands } from './commands/actions';
import { COMMANDS, registerCommand, registerCoreCommands, type ToolkitServices } from './commands/registerCommands';
import { UserFacingError } from './core/errors';
import { Logger } from './core/logging';
import { DotnetCommandRunner } from './dotnet/commandRunner';
import { FileAppDetector } from './dotnet/fileAppDetector';
import { SdkService } from './dotnet/sdkService';
import { registerFileAppTaskProvider } from './dotnet/taskProvider';
import { registerActionPicker } from './ui/actionPicker';

export interface ToolkitApi {
  readonly detector: FileAppDetector;
  readonly runner: DotnetCommandRunner;
}

export function activate(context: vscode.ExtensionContext): ToolkitApi {
  const logger = new Logger('.NET File Apps');
  context.subscriptions.push(logger);
  logger.info(`Activating .NET File Apps Toolkit ${context.extension.packageJSON.version ?? ''}`);

  const sdk = new SdkService(logger);
  const detector = new FileAppDetector(context.workspaceState, logger);
  const runner = new DotnetCommandRunner(logger);
  context.subscriptions.push(sdk, detector, runner, registerFileAppTaskProvider(logger));

  const services: ToolkitServices = { context, logger, sdk, detector, runner };
  registerCoreCommands(services);
  registerActionCommands(services);
  registerActionPicker(services);

  registerCommand(services, COMMANDS.previewComments, () => {
    throw new UserFacingError(vscode.l10n.t('This command is not available yet.'), [], 'info');
  });

  return { detector, runner };
}

export function deactivate(): void {
  // Disposables registered on the extension context are released by VS Code.
}
