import * as vscode from 'vscode';
import type { Logger } from './logging';

export interface ErrorAction {
  readonly title: string;
  readonly run: () => unknown;
}

/** An error whose message is safe and meant to be shown to the user as-is. */
export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly actions: readonly ErrorAction[] = [],
    readonly severity: 'error' | 'warning' | 'info' = 'error',
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}

/** Thrown when the user cancels a flow; never reported as an error. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export async function reportError(err: unknown, logger: Logger): Promise<void> {
  if (err instanceof CancelledError) {
    logger.debug('Operation cancelled by user.');
    return;
  }
  const showLogs = vscode.l10n.t('Show Logs');
  if (err instanceof UserFacingError) {
    logger.warn(err.message);
    const titles = [...err.actions.map((a) => a.title), showLogs];
    const show =
      err.severity === 'info'
        ? vscode.window.showInformationMessage
        : err.severity === 'warning'
          ? vscode.window.showWarningMessage
          : vscode.window.showErrorMessage;
    const picked = await show(err.message, ...titles);
    if (picked === showLogs) {
      logger.show();
    } else if (picked) {
      await err.actions.find((a) => a.title === picked)?.run();
    }
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error(err instanceof Error ? err : message);
  const picked = await vscode.window.showErrorMessage(vscode.l10n.t('.NET File Apps: {0}', message), showLogs);
  if (picked === showLogs) {
    logger.show();
  }
}
