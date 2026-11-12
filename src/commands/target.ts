import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { UserFacingError } from '../core/errors';

/**
 * Resolves the `.cs` file a command should act on. Editor-title and context-menu invocations pass the
 * clicked editor's URI; Command Palette invocations fall back to the active editor or tab.
 */
export function resolveTargetUri(arg: unknown): vscode.Uri {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    return active;
  }
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }
  throw new UserFacingError(vscode.l10n.t('Open a C# file (.cs) to use this command.'), [], 'info');
}

/** Validates that the target is an existing local `.cs` file and returns its URI. */
export async function validateLocalCSharpFile(uri: vscode.Uri): Promise<vscode.Uri> {
  if (uri.scheme === 'untitled') {
    throw new UserFacingError(vscode.l10n.t('Save the file with a .cs extension before using .NET File Apps commands.'), [], 'warning');
  }
  if (uri.scheme !== 'file') {
    throw new UserFacingError(
      vscode.l10n.t('.NET File Apps commands only support files on the local or remote workspace file system (scheme "{0}" is not supported).', uri.scheme),
      [],
      'warning',
    );
  }
  if (path.extname(uri.fsPath).toLowerCase() !== '.cs') {
    throw new UserFacingError(vscode.l10n.t('"{0}" is not a C# (.cs) file.', path.basename(uri.fsPath)), [], 'warning');
  }
  try {
    const stat = await fs.stat(uri.fsPath);
    if (!stat.isFile()) {
      throw new Error('not a file');
    }
  } catch {
    throw new UserFacingError(vscode.l10n.t('"{0}" does not exist on disk. Save it first.', uri.fsPath), [], 'warning');
  }
  return uri;
}
