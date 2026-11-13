import * as vscode from 'vscode';
import { registerActionCommands } from './commands/actions';
import { COMMANDS, registerCommand, registerCoreCommands, type ToolkitServices } from './commands/registerCommands';
import { resolveTargetUri } from './commands/target';
import { CodeHighlighter } from './comments/codeHighlighter';
import { registerTaggedCommentHover } from './comments/hoverProvider';
import { MarkdownDecorationController } from './comments/markdownDecorations';
import { TaggedCommentPreviewManager } from './comments/previewPanel';
import { SyntaxHighlightController } from './comments/syntaxHighlightController';
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
  readonly syntaxHighlights: SyntaxHighlightController;
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
  let highlighter: Promise<CodeHighlighter | undefined> | undefined;
  // Shiki loads lazily on first use and is shared by the preview and the editor decoration fallback.
  const getHighlighter = (): Promise<CodeHighlighter | undefined> =>
    (highlighter ??= CodeHighlighter.create().catch((err) => {
      logger.warn(`Syntax highlighter failed to load; tagged code comments use plain text: ${err}`);
      return undefined;
    }));
  const markdownDecorations = new MarkdownDecorationController(comments);
  const syntaxHighlights = new SyntaxHighlightController(comments, getHighlighter, logger);
  const previews = new TaggedCommentPreviewManager(context.extensionUri, comments, logger, getHighlighter);
  context.subscriptions.push(comments, markdownDecorations, syntaxHighlights, previews, registerTaggedCommentHover(comments));

  const services: ToolkitServices = { context, logger, sdk, detector, runner, comments };
  registerCoreCommands(services);
  registerActionCommands(services);
  registerActionPicker(services);

  registerCommand(services, COMMANDS.previewComments, async (arg) => {
    await previews.show(resolveTargetUri(arg));
  });

  return { detector, runner, comments, previews, markdownDecorations, syntaxHighlights };
}

export function deactivate(): void {
  // Disposables registered on the extension context are released by VS Code.
}
