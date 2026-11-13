import * as path from 'node:path';
import * as vscode from 'vscode';
import { CancelledError, UserFacingError } from '../core/errors';
import { findBlockAt } from '../comments/taggedCommentScanner';
import { isCSharpDocument } from '../comments/taggedCommentService';
import { COMMANDS, registerCommand, type ToolkitServices } from './registerCommands';
import { resolveTargetUri } from './target';

const FILE_SUFFIX: Readonly<Record<string, string>> = {
  markdown: 'md',
  yaml: 'yaml',
  json: 'json',
  sql: 'sql',
  xml: 'xml',
  bash: 'sh',
  powershell: 'ps1',
  csharp: 'cs',
  javascript: 'js',
  typescript: 'ts',
  html: 'html',
  css: 'css',
  python: 'py',
  cpp: 'cpp',
  toml: 'toml',
  ini: 'ini',
  dockerfile: 'Dockerfile',
  csv: 'csv',
};

function isSameFile(left: vscode.Uri, right: vscode.Uri): boolean {
  if (left.scheme !== right.scheme) {
    return false;
  }
  if (left.scheme !== 'file') {
    return left.toString() === right.toString();
  }
  const leftPath = path.resolve(left.fsPath);
  const rightPath = path.resolve(right.fsPath);
  return process.platform === 'win32' ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath;
}

async function findCurrentBlock(services: ToolkitServices, arg: unknown) {
  const uri = resolveTargetUri(arg);
  const document = await vscode.workspace.openTextDocument(uri);
  if (!isCSharpDocument(document)) {
    throw new UserFacingError(vscode.l10n.t('Open a C# file containing tagged comments first.'), [], 'info');
  }
  if (!services.comments.isEnabled(uri)) {
    throw new UserFacingError(vscode.l10n.t('Tagged comments are disabled. Enable "dotnetFileAppsToolkit.comments.enabled" to use this action.'), [], 'info');
  }
  const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === document);
  const block = editor ? findBlockAt(services.comments.getScan(document), document.offsetAt(editor.selection.active)) : undefined;
  if (!block) {
    throw new UserFacingError(vscode.l10n.t('Place the cursor inside a tagged comment to use this action.'), [], 'info');
  }
  return { document, block };
}

function extractedBody(block: { readonly normalizedBody: string; readonly rawBody: string }): string {
  return block.normalizedBody + (/(?:\r\n|\r|\n)$/.test(block.rawBody) ? '\n' : '');
}

function defaultFileName(document: vscode.TextDocument, language: string): string {
  const suffix = FILE_SUFFIX[language];
  if (!suffix) {
    throw new UserFacingError(vscode.l10n.t('No extraction file type is configured for {0}.', language));
  }
  const source = document.uri.fsPath || document.uri.path;
  const base = path.basename(source, path.extname(source));
  return suffix === 'Dockerfile' ? `${base}-Dockerfile` : `${base}.${suffix}`;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

async function confirmWrite(target: vscode.Uri, language: string): Promise<void> {
  let exists = false;
  try {
    const stat = await vscode.workspace.fs.stat(target);
    if ((stat.type & vscode.FileType.File) === 0) {
      throw new UserFacingError(vscode.l10n.t('The extraction target is not a file: {0}', target.fsPath || target.path));
    }
    exists = true;
  } catch (error) {
    if (error instanceof UserFacingError || !isFileNotFound(error)) {
      throw error;
    }
  }
  const dirtyDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === target.toString() && document.isDirty);
  if (dirtyDocument) {
    throw new UserFacingError(vscode.l10n.t('The extraction target has unsaved changes. Save or close it before overwriting.'));
  }
  const action = exists ? vscode.l10n.t('Overwrite and Extract') : vscode.l10n.t('Extract');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('Extract {0} to {1}?', language, target.fsPath || target.path),
    {
      modal: true,
      detail: vscode.l10n.t('The tagged comment body will be written as a standalone file. Its code will not be executed.'),
    },
    action,
  );
  if (choice !== action) {
    throw new CancelledError();
  }
}

export function registerTaggedCommentActions(services: ToolkitServices): void {
  registerCommand(services, COMMANDS.copyTaggedComment, async (arg) => {
    const { block } = await findCurrentBlock(services, arg);
    await vscode.env.clipboard.writeText(block.rawBody);
    vscode.window.setStatusBarMessage(
      vscode.l10n.t('Copied the {0} comment body to the clipboard.', block.descriptor.displayName),
      3000,
    );
  });

  registerCommand(services, COMMANDS.extractTaggedComment, async (arg) => {
    const { document, block } = await findCurrentBlock(services, arg);
    const sourceFolder =
      document.uri.scheme === 'file'
        ? vscode.Uri.file(path.dirname(document.uri.fsPath))
        : vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = sourceFolder ? vscode.Uri.joinPath(sourceFolder, defaultFileName(document, block.language)) : undefined;
    const suffix = FILE_SUFFIX[block.language];
    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Extract {0} comment to a file', block.descriptor.displayName),
      saveLabel: vscode.l10n.t('Choose Extraction File'),
      defaultUri,
      filters: suffix === 'Dockerfile' ? { Dockerfile: ['Dockerfile'] } : { [block.descriptor.displayName]: [suffix] },
    });
    if (!target) {
      throw new CancelledError();
    }
    if (isSameFile(document.uri, target)) {
      throw new UserFacingError(vscode.l10n.t('A tagged comment cannot be extracted over its source file.'), [], 'warning');
    }
    await confirmWrite(target, block.descriptor.displayName);
    await vscode.workspace.fs.writeFile(target, Buffer.from(extractedBody(block), 'utf8'));
    void vscode.window.showInformationMessage(vscode.l10n.t('Extracted the {0} comment body to {1}.', block.descriptor.displayName, target.fsPath || target.path));
  });
}
