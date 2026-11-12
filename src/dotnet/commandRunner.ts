import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CancelledError } from '../core/errors';
import type { Logger } from '../core/logging';
import { formatCommandLine, type DotnetAction } from './cliArgs';

export const TASK_TYPE = 'dotnet-file-app';
export const TASK_SOURCE = 'File Apps';

/**
 * - `terminal`: integrated terminal (VS Code task with a real pty, or a pseudoterminal fallback).
 * - `captured`: no terminal; stdin is redirected so the CLI can never prompt, output goes to the log.
 */
export type CommandPresentation = 'terminal' | 'captured';

export interface DotnetCommand {
  readonly action: DotnetAction;
  readonly fileUri: vscode.Uri;
  readonly dotnetPath: string;
  /** Arguments after the `dotnet` executable; never joined into a shell string. */
  readonly args: readonly string[];
  /** Localized task name, e.g. "Run hello.cs". */
  readonly name: string;
  /** Application arguments, recorded in the task definition for `run`. */
  readonly appArgs?: readonly string[];
  /** Focus the terminal so the user can type input (used for runs). */
  readonly focus?: boolean;
  readonly presentation?: CommandPresentation;
}

export interface CommandOutcome {
  /** Process exit code; `undefined` when the process did not start or was terminated. */
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
  /** Combined stdout/stderr (tail) for `captured` commands. */
  readonly output?: string;
}

interface RunningOperation {
  readonly command: DotnetCommand;
  readonly done: Promise<CommandOutcome>;
  terminate(): void;
}

interface ProcessHandle {
  readonly exited: Promise<number | undefined>;
  terminate(): void;
  output?(): string;
}

/** Environment overrides for every CLI invocation (merged with the extension host environment). */
export const COMMAND_ENV: Readonly<Record<string, string>> = { DOTNET_NOLOGO: '1' };

const MAX_CAPTURED_OUTPUT = 64 * 1024;

export function fileKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function buildTaskDefinition(command: Pick<DotnetCommand, 'action' | 'fileUri' | 'appArgs'>): vscode.TaskDefinition {
  const definition: vscode.TaskDefinition = { type: TASK_TYPE, action: command.action, file: command.fileUri.fsPath };
  if (command.appArgs && command.appArgs.length > 0) {
    definition.args = [...command.appArgs];
  }
  return definition;
}

/**
 * Runs .NET CLI commands for file-based apps. Uses VS Code tasks (integrated terminal with a real pty,
 * problem matchers) when possible, and a pseudoterminal-backed child process otherwise. Only one
 * operation per source file runs at a time to avoid file-based app build-cache contention.
 */
export class DotnetCommandRunner implements vscode.Disposable {
  private readonly running = new Map<string, RunningOperation>();
  private readonly ptyTerminals = new Map<string, vscode.Terminal>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly logger: Logger) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        for (const [key, terminal] of this.ptyTerminals) {
          if (terminal === t) {
            this.ptyTerminals.delete(key);
          }
        }
      }),
    );
  }

  getRunning(fileUri: vscode.Uri): DotnetCommand | undefined {
    return this.running.get(fileKey(fileUri.fsPath))?.command;
  }

  /** Terminates the operation running for the file, if any, and waits for it to end. */
  async stop(fileUri: vscode.Uri): Promise<void> {
    const op = this.running.get(fileKey(fileUri.fsPath));
    if (op) {
      op.terminate();
      await op.done.catch(() => undefined);
    }
  }

  /**
   * Starts the command and resolves when the process ends. Throws if an operation is already running
   * for the same file (callers should check {@link getRunning} first and offer to stop it).
   */
  async execute(command: DotnetCommand, token?: vscode.CancellationToken): Promise<CommandOutcome> {
    const key = fileKey(command.fileUri.fsPath);
    if (this.running.has(key)) {
      throw new Error(`An operation is already running for ${command.fileUri.fsPath}.`);
    }
    if (token?.isCancellationRequested) {
      throw new CancelledError();
    }
    const cwd = path.dirname(command.fileUri.fsPath);
    this.logger.info(`> ${formatCommandLine(command.dotnetPath, command.args)}  (cwd: ${cwd})`);

    let handle: ProcessHandle | undefined;
    let cancelled = false;
    const terminate = () => {
      cancelled = true;
      handle?.terminate();
    };
    const done = (async (): Promise<CommandOutcome> => {
      const cancelSub = token?.onCancellationRequested(terminate);
      try {
        handle = await this.start(command, cwd);
        if (cancelled) {
          handle.terminate();
        }
        const exitCode = await handle.exited;
        return { exitCode: cancelled ? undefined : exitCode, cancelled, output: handle.output?.() };
      } finally {
        cancelSub?.dispose();
      }
    })();

    const op: RunningOperation = { command, done, terminate };
    this.running.set(key, op);
    try {
      const outcome = await done;
      this.logger.info(
        outcome.cancelled
          ? `${command.name}: cancelled`
          : `${command.name}: exited with code ${outcome.exitCode ?? 'unknown'}`,
      );
      return outcome;
    } finally {
      this.running.delete(key);
    }
  }

  private async start(command: DotnetCommand, cwd: string): Promise<ProcessHandle> {
    if (command.presentation === 'captured') {
      return startCaptured(command, cwd, this.logger);
    }
    const folder = vscode.workspace.getWorkspaceFolder(command.fileUri) ?? vscode.workspace.workspaceFolders?.[0];
    // The task system substitutes ${...} variables in process arguments; run such commands verbatim instead.
    const needsVerbatim = command.args.some((a) => a.includes('${'));
    if (folder && !needsVerbatim) {
      try {
        return await startTask(command, cwd, folder);
      } catch (err) {
        this.logger.warn(`Could not start a VS Code task (${err instanceof Error ? err.message : String(err)}); using a terminal instead.`);
      }
    }
    return this.startPseudoterminal(command, cwd);
  }

  private startPseudoterminal(command: DotnetCommand, cwd: string): ProcessHandle {
    const pty = new ProcessPseudoterminal(command.dotnetPath, command.args, cwd);
    const key = fileKey(command.fileUri.fsPath) + '\u0000' + command.action;
    this.ptyTerminals.get(key)?.dispose();
    const terminal = vscode.window.createTerminal({
      name: `${TASK_SOURCE}: ${command.name}`,
      pty,
      iconPath: new vscode.ThemeIcon('play'),
      isTransient: true,
    });
    this.ptyTerminals.set(key, terminal);
    terminal.show(!command.focus);
    return { exited: pty.exited, terminate: () => pty.terminate() };
  }

  dispose(): void {
    for (const op of this.running.values()) {
      op.terminate();
    }
    this.running.clear();
    this.disposables.forEach((d) => d.dispose());
  }
}

async function startTask(command: DotnetCommand, cwd: string, folder: vscode.WorkspaceFolder): Promise<ProcessHandle> {
  const execution = new vscode.ProcessExecution(command.dotnetPath, [...command.args], { cwd, env: { ...COMMAND_ENV } });
  const problemMatchers = command.action === 'clean' || command.action === 'convert' ? [] : ['$msCompile'];
  const task = new vscode.Task(buildTaskDefinition(command), folder, command.name, TASK_SOURCE, execution, problemMatchers);
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    focus: command.focus ?? false,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    echo: true,
    showReuseMessage: true,
  };
  if (command.action === 'build' || command.action === 'restore' || command.action === 'publish') {
    task.group = vscode.TaskGroup.Build;
  }

  // Events can fire before executeTask resolves, so buffer them until the execution is known.
  const started = new Set<vscode.TaskExecution>();
  const processExit = new Map<vscode.TaskExecution, number | undefined>();
  const ended = new Set<vscode.TaskExecution>();
  let target: vscode.TaskExecution | undefined;
  let terminateRequested = false;
  let resolveExit!: (code: number | undefined) => void;
  const exited = new Promise<number | undefined>((resolve) => (resolveExit = resolve));

  // A task can only be terminated once the task system reports it as started.
  const tryTerminate = () => {
    if (terminateRequested && target && started.has(target) && !ended.has(target)) {
      target.terminate();
    }
  };
  const settle = () => {
    if (target && ended.has(target)) {
      subs.forEach((s) => s.dispose());
      resolveExit(processExit.get(target));
    }
  };
  const subs = [
    vscode.tasks.onDidStartTask((e) => {
      started.add(e.execution);
      tryTerminate();
    }),
    vscode.tasks.onDidEndTaskProcess((e) => {
      processExit.set(e.execution, e.exitCode);
    }),
    vscode.tasks.onDidEndTask((e) => {
      ended.add(e.execution);
      settle();
    }),
  ];
  try {
    target = await vscode.tasks.executeTask(task);
  } catch (err) {
    subs.forEach((s) => s.dispose());
    throw err;
  }
  settle();
  return {
    exited,
    terminate: () => {
      terminateRequested = true;
      tryTerminate();
    },
  };
}

function startCaptured(command: DotnetCommand, cwd: string, logger: Logger): ProcessHandle {
  let output = '';
  let terminated = false;
  const child = spawn(command.dotnetPath, [...command.args], {
    cwd,
    env: { ...process.env, ...COMMAND_ENV },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const collect = (d: Buffer) => {
    const text = d.toString();
    output = (output + text).slice(-MAX_CAPTURED_OUTPUT);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length > 0) {
        logger.info(`  ${line}`);
      }
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const exited = new Promise<number | undefined>((resolve) => {
    child.on('error', (err) => {
      output += err.message;
      logger.error(`${command.name}: ${err.message}`);
      resolve(undefined);
    });
    child.on('close', (code) => resolve(terminated ? undefined : (code ?? undefined)));
  });
  return {
    exited,
    terminate: () => {
      terminated = true;
      killTree(child);
    },
    output: () => output,
  };
}

/** Kills a process and its descendants (`dotnet run` starts the app as a child process). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }, 3000).unref();
}

/**
 * Integrated-terminal front end for a child process started without a shell. Used when no workspace
 * folder is open (tasks are unavailable) or arguments must not be variable-substituted.
 */
class ProcessPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private child: ChildProcess | undefined;
  private line = '';
  private resolveExit!: (code: number | undefined) => void;
  readonly exited = new Promise<number | undefined>((resolve) => (this.resolveExit = resolve));
  private finished = false;
  private terminated = false;

  constructor(
    private readonly executable: string,
    private readonly args: readonly string[],
    private readonly cwd: string,
  ) {}

  open(): void {
    this.write(`\x1b[2m> ${formatCommandLine(this.executable, this.args)}\x1b[0m\n\n`);
    const child = spawn(this.executable, [...this.args], {
      cwd: this.cwd,
      env: { ...process.env, ...COMMAND_ENV },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => this.write(d.toString()));
    child.stderr?.on('data', (d: Buffer) => this.write(d.toString()));
    child.on('error', (err) => {
      this.write(`\n\x1b[31m${err.message}\x1b[0m\n`);
      this.finish(undefined);
    });
    child.on('close', (code) => this.finish(this.terminated ? undefined : (code ?? undefined)));
  }

  handleInput(data: string): void {
    if (this.finished || !this.child?.stdin) {
      return;
    }
    if (data === '\x03') {
      this.write('^C\n');
      this.terminate();
      return;
    }
    for (const ch of data) {
      if (ch === '\r') {
        this.write('\n');
        this.child.stdin.write(this.line + '\n');
        this.line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.writeEmitter.fire('\b \b');
        }
      } else if (ch >= ' ') {
        this.line += ch;
        this.writeEmitter.fire(ch);
      }
    }
  }

  close(): void {
    this.terminate();
  }

  terminate(): void {
    if (!this.finished && this.child) {
      this.terminated = true;
      killTree(this.child);
    } else if (!this.child) {
      this.finish(undefined);
    }
  }

  private finish(code: number | undefined): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const status = this.terminated ? 'terminated' : `exited with code ${code ?? 'unknown'}`;
    this.write(`\n\x1b[2mProcess ${status}.\x1b[0m\n`);
    this.resolveExit(code);
  }

  private write(text: string): void {
    this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
  }
}
