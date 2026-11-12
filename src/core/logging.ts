import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  trace(message: string, ...args: unknown[]): void {
    this.channel.trace(message, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.channel.debug(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.channel.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.channel.warn(message, ...args);
  }

  error(message: string | Error, ...args: unknown[]): void {
    this.channel.error(message, ...args);
  }

  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
