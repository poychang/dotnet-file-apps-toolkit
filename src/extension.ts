import * as vscode from 'vscode';
import { registerActionCommands } from './commands/actions';
import { COMMANDS, registerCommand, registerCoreCommands, type ToolkitServices } from './commands/registerCommands';
import { resolveTargetUri } from './commands/target';
import { registerTaggedCommentHover } from './comments/hoverProvider';
import { MarkdownDecorationController } from './comments/markdownDecorations';
import { TaggedCommentPreviewManager } from './comments/previewPanel';
import { TaggedCommentService } from './comments/taggedCommentService';
import { Logger } from './core/logging';
import { DotnetCommandRunner } from './dotnet/commandRunner';
import { FileAppDetector } from './dotnet/fileAppDetector';
import { SdkService } from './dotnet/sdkService';
import { registerFileAppTaskProvider } from './dotnet/taskProvider';
import { registerActionPicker } from './ui/actionPicker';

export interface ToolkitApi {
  readonly detector: FileAppDetector;
  readonly runner: DotnetCommandRunner;
  readonly comments: TaggedCommentService;
  readonly previews: TaggedCommentPreviewManager;
  readonly markdownDecorations: MarkdownDecorationController;
}

export function activate(context: vscode.ExtensionContext): ToolkitApi {
  const logger = new Logger('.NET File Apps');
  context.subscriptions.push(logger);
  logger.info(`Activating .NET File Apps Toolkit ${context.extension.packageJSON.version ?? ''}`);

  const sdk = new SdkService(logger);
  const detector = new FileAppDetector(context.workspaceState, logger);
  const runner = new DotnetCommandRunner(logger);
  context.subscriptions.push(sdk, detector, runner, registerFileAppTaskProvider(logger));

  const comments = new TaggedCommentService(logger);
  const markdownDecorations = new MarkdownDecorationController(comments);
  const previews = new TaggedCommentPreviewManager(context.extensionUri, comments, logger);
  context.subscriptions.push(comments, markdownDecorations, previews, registerTaggedCommentHover(comments));

  const services: ToolkitServices = { context, logger, sdk, detector, runner };
  registerCoreCommands(services);
  registerActionCommands(services);
  registerActionPicker(services);

  registerCommand(services, COMMANDS.previewComments, async (arg) => {
    await previews.show(resolveTargetUri(arg));
  });

  return { detector, runner, comments, previews, markdownDecorations };
}

export function deactivate(): void {
  // Disposables registered on the extension context are released by VS Code.
}
