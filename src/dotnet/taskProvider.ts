import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../core/logging';
import { getSettings } from '../core/settings';
import { buildBuildArgs, buildCleanArgs, buildPublishArgs, buildRestoreArgs, buildRunArgs } from './cliArgs';
import { COMMAND_ENV, TASK_SOURCE, TASK_TYPE } from './commandRunner';

const TASK_ACTIONS = ['run', 'restore', 'build', 'clean', 'publish'] as const;
type TaskAction = (typeof TASK_ACTIONS)[number];

interface FileAppTaskDefinition extends vscode.TaskDefinition {
  readonly action: TaskAction;
  readonly file: string;
  readonly args?: readonly string[];
}

function isFileAppTaskDefinition(def: vscode.TaskDefinition): def is FileAppTaskDefinition {
  return (
    typeof def.action === 'string' &&
    (TASK_ACTIONS as readonly string[]).includes(def.action) &&
    typeof def.file === 'string' &&
    def.file.trim().length > 0 &&
    (def.args === undefined || (Array.isArray(def.args) && def.args.every((a: unknown) => typeof a === 'string')))
  );
}

/**
 * Resolves `"type": "dotnet-file-app"` entries from tasks.json. No tasks are auto-detected; the
 * editor actions create their own tasks.
 */
export function registerFileAppTaskProvider(logger: Logger): vscode.Disposable {
  return vscode.tasks.registerTaskProvider(TASK_TYPE, {
    provideTasks: () => [],
    resolveTask(task) {
      const def = task.definition;
      if (!isFileAppTaskDefinition(def)) {
        logger.warn(`Ignoring invalid ${TASK_TYPE} task "${task.name}": "action" and "file" are required.`);
        return undefined;
      }
      const folder = typeof task.scope === 'object' ? task.scope : vscode.workspace.workspaceFolders?.[0];
      let file = def.file.trim();
      if (!file.includes('${') && !path.isAbsolute(file) && folder) {
        file = path.join(folder.uri.fsPath, file);
      }
      // ${file} has no directory component to derive; the task system resolves ${fileDirname} itself.
      const cwd = file === '${file}' ? '${fileDirname}' : path.dirname(file);
      const args = {
        run: () => buildRunArgs(file, def.args ?? []),
        restore: () => buildRestoreArgs(file),
        build: () => buildBuildArgs(file),
        clean: () => buildCleanArgs(file),
        publish: () => buildPublishArgs(file),
      }[def.action]();
      const execution = new vscode.ProcessExecution(getSettings(folder?.uri).dotnetPath, args, { cwd, env: { ...COMMAND_ENV } });
      const resolved = new vscode.Task(
        def,
        task.scope ?? vscode.TaskScope.Workspace,
        task.name,
        TASK_SOURCE,
        execution,
        def.action === 'clean' ? [] : ['$msCompile'],
      );
      if (def.action !== 'run' && def.action !== 'clean') {
        resolved.group = vscode.TaskGroup.Build;
      }
      return resolved;
    },
  });
}
