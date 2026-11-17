import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ToolkitApi } from '../../src/extension';
import { promises as fs } from 'node:fs';

export const EXTENSION_ID = 'PoyChang.dotnet-file-apps-toolkit';

export function workspaceDir(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('Integration tests require a workspace folder.');
  }
  return folder.uri.fsPath;
}

export function fixtureUri(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(workspaceDir(), name));
}

export async function activateExtension(): Promise<ToolkitApi> {
  const ext = vscode.extensions.getExtension<ToolkitApi>(EXTENSION_ID);
  if (!ext) {
    throw new Error(`Extension ${EXTENSION_ID} not found.`);
  }
  return ext.activate();
}

export async function restoreDocumentFromDisk(document: vscode.TextDocument): Promise<void> {
  const contents = await fs.readFile(document.uri.fsPath, 'utf8');
  const editor = await vscode.window.showTextDocument(document);
  const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  const edited = await editor.edit((builder) => builder.replace(range, contents));
  if (!edited || !(await document.save())) {
    throw new Error(`Could not restore ${document.uri.fsPath} from disk.`);
  }
}

export async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 15_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export type MessageKind = 'info' | 'warning' | 'error';

export interface RecordedMessage {
  readonly kind: MessageKind;
  readonly message: string;
  readonly modal: boolean;
  readonly items: readonly string[];
}

type Responder = (m: RecordedMessage) => string | undefined;

/**
 * Replaces notification/dialog APIs on the shared `vscode` API object so commands never block on
 * user interaction. Tests script the answers through the responder callbacks.
 */
export class UiStub {
  readonly messages: RecordedMessage[] = [];
  respond: Responder = () => undefined;
  pick: (items: readonly vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined = () => undefined;
  input: (options: vscode.InputBoxOptions | undefined) => string | undefined = () => undefined;
  openFiles: (options: vscode.OpenDialogOptions | undefined) => readonly vscode.Uri[] | undefined = () => undefined;
  saveFile: (options: vscode.SaveDialogOptions | undefined) => vscode.Uri | undefined = () => undefined;
  private readonly originals: Partial<Record<keyof typeof vscode.window, unknown>> = {};

  install(): void {
    const win = vscode.window as unknown as Record<string, unknown>;
    const message =
      (kind: MessageKind) =>
      (msg: string, ...rest: unknown[]): Thenable<unknown> => {
        let modal = false;
        if (rest.length > 0 && typeof rest[0] === 'object' && rest[0] !== null && !('title' in rest[0])) {
          modal = Boolean((rest.shift() as vscode.MessageOptions).modal);
        }
        const items = rest.map((i) => (typeof i === 'string' ? i : (i as vscode.MessageItem).title));
        const recorded = { kind, message: msg, modal, items };
        this.messages.push(recorded);
        return Promise.resolve(this.respond(recorded));
      };
    this.replace(win, 'showInformationMessage', message('info'));
    this.replace(win, 'showWarningMessage', message('warning'));
    this.replace(win, 'showErrorMessage', message('error'));
    this.replace(win, 'showQuickPick', async (items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>) =>
      this.pick(await items),
    );
    this.replace(win, 'showInputBox', async (options?: vscode.InputBoxOptions) => {
      const value = this.input(options);
      if (value !== undefined && options?.validateInput) {
        const error = await options.validateInput(value);
        if (error) {
          throw new Error(`Input "${value}" was rejected: ${typeof error === 'string' ? error : error.message}`);
        }
      }
      return value;
    });
    this.replace(win, 'showOpenDialog', async (options?: vscode.OpenDialogOptions) => this.openFiles(options));
    this.replace(win, 'showSaveDialog', async (options?: vscode.SaveDialogOptions) => this.saveFile(options));
  }

  reset(): void {
    this.messages.length = 0;
    this.respond = () => undefined;
    this.pick = () => undefined;
    this.input = () => undefined;
    this.openFiles = () => undefined;
    this.saveFile = () => undefined;
  }

  restore(): void {
    const win = vscode.window as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(this.originals)) {
      win[key] = value;
    }
  }

  errors(): RecordedMessage[] {
    return this.messages.filter((m) => m.kind === 'error');
  }

  private replace(win: Record<string, unknown>, key: keyof typeof vscode.window, value: unknown): void {
    this.originals[key] = win[key];
    win[key] = value;
  }
}
