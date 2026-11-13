import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CancelledError, UserFacingError } from '../core/errors';
import { CONFIG_SECTION, getSettings, type AutoSaveBeforeRun } from '../core/settings';
import {
  buildBuildArgs,
  buildCleanArgs,
  buildConvertArgs,
  buildFileAppCacheCleanArgs,
  buildFormatArgs,
  buildPackArgs,
  buildPublishArgs,
  buildReferenceArgs,
  buildRestoreArgs,
  buildRunArgs,
  convertedProjectFile,
  defaultConvertOutputDir,
  defaultPublishOutputDir,
  formatArgumentString,
  isPublishAotDisabled,
  isPackAsToolDisabled,
  parseArgumentString,
  type DotnetAction,
} from '../dotnet/cliArgs';
import { makeDirectiveInsertion, packageDirectiveId, parsePackageReference } from '../dotnet/directiveEdits';
import type { CommandOutcome, DotnetCommand } from '../dotnet/commandRunner';
import type { DetectionResult } from '../dotnet/fileAppDetector';
import { analyzeFileAppText, type FileAppDirective } from '../dotnet/fileAppSignals';
import { parseLaunchProfiles, type LaunchProfile } from '../dotnet/launchProfiles';
import { COMMANDS, registerCommand, type ToolkitServices } from './registerCommands';
import { registerTaggedCommentActions } from './taggedCommentActions';
import { requireWorkspaceTrust, resolveTargetUri, validateLocalCSharpFile } from './target';

const LAST_ARGS_STATE_KEY = 'dotnetFileApps.lastArgs';
const MAX_REMEMBERED_ARGS = 100;

function actionTitle(action: DotnetAction): string {
  switch (action) {
    case 'run':
      return vscode.l10n.t('Run');
    case 'restore':
      return vscode.l10n.t('Restore');
    case 'build':
      return vscode.l10n.t('Build');
    case 'clean':
      return vscode.l10n.t('Clean');
    case 'publish':
      return vscode.l10n.t('Publish');
    case 'pack':
      return vscode.l10n.t('Pack as Tool');
    case 'reference':
      return vscode.l10n.t('Manage Project References');
    case 'format':
      return vscode.l10n.t('Format File');
    case 'convert':
      return vscode.l10n.t('Convert');
  }
}

function taskName(action: DotnetAction, uri: vscode.Uri): string {
  return `${actionTitle(action)} ${path.basename(uri.fsPath)}`;
}

interface FileAppTarget {
  readonly uri: vscode.Uri;
  readonly detection: DetectionResult;
}

interface DirectiveActionItem extends vscode.QuickPickItem {
  readonly action: 'add-package' | 'edit-directive';
  readonly directive?: FileAppDirective;
}

/**
 * Validates the clicked/active file, workspace trust and file-app recognition. Never relies on the
 * context key used for menus: the handler re-checks everything for the URI it actually acts on.
 */
async function resolveFileAppTarget(
  services: ToolkitServices,
  arg: unknown,
  action: DotnetAction,
  needsWorkspaceTrust = true,
): Promise<FileAppTarget> {
  const uri = await validateLocalCSharpFile(resolveTargetUri(arg));
  if (needsWorkspaceTrust) {
    requireWorkspaceTrust(actionTitle(action));
  }
  const detection = await services.detector.detect(uri);
  if (detection.decision.isFileApp) {
    return { uri, detection };
  }
  const name = path.basename(uri.fsPath);
  const why =
    detection.decision.reason === 'override-disabled'
      ? vscode.l10n.t('The toolkit is disabled for this file.')
      : detection.decision.reason === 'inside-project'
        ? vscode.l10n.t('It is inside a folder tree that contains a project file (.csproj), so it is probably part of that project.')
        : vscode.l10n.t('It does not start with #: directives or a dotnet shebang.');
  const enable = vscode.l10n.t('Enable for This File');
  const once = vscode.l10n.t('Continue Once');
  const picked = await vscode.window.showWarningMessage(
    vscode.l10n.t('{0} is not recognized as a .NET file-based app.', name),
    { modal: true, detail: `${why}\n${vscode.l10n.t('The .NET CLI will treat it as a standalone file-based app.')}` },
    enable,
    once,
  );
  if (!picked) {
    throw new CancelledError();
  }
  if (picked === enable) {
    await services.detector.setOverride(uri, 'enabled');
  }
  return { uri, detection };
}

async function ensureSaved(uri: vscode.Uri, mode: AutoSaveBeforeRun, action: DotnetAction): Promise<void> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (!doc?.isDirty) {
    return;
  }
  const name = path.basename(uri.fsPath);
  const save = async () => {
    if (!(await doc.save())) {
      throw new UserFacingError(vscode.l10n.t('{0} could not be saved. The command was not run.', name));
    }
  };
  if (mode === 'always') {
    return save();
  }
  if (mode === 'never') {
    throw new UserFacingError(
      vscode.l10n.t('{0} has unsaved changes. Save it first: the .NET CLI reads the file from disk.', name),
      [
        { title: vscode.l10n.t('Save'), run: () => doc.save() },
        {
          title: vscode.l10n.t('Open Settings'),
          run: () => vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG_SECTION}.autoSaveBeforeRun`),
        },
      ],
      'warning',
    );
  }
  const saveLabel = vscode.l10n.t('Save');
  const alwaysLabel = vscode.l10n.t('Always Save');
  const picked = await vscode.window.showWarningMessage(
    vscode.l10n.t('Save changes to {0} before "{1}"?', name, actionTitle(action)),
    { modal: true, detail: vscode.l10n.t('The .NET CLI reads the file from disk.') },
    saveLabel,
    alwaysLabel,
  );
  if (!picked) {
    throw new CancelledError();
  }
  if (picked === alwaysLabel) {
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update('autoSaveBeforeRun', 'always', vscode.ConfigurationTarget.Global);
  }
  await save();
}

/** Resolves the SDK (failing with an actionable error) and saves the document. */
async function prepareExecution(services: ToolkitServices, uri: vscode.Uri, action: DotnetAction): Promise<string> {
  const sdk = await services.sdk.require(uri);
  await ensureSaved(uri, getSettings(uri).autoSaveBeforeRun, action);
  return sdk.dotnetPath;
}

async function execute(
  services: ToolkitServices,
  command: DotnetCommand,
  progressTitle?: string,
): Promise<CommandOutcome> {
  const running = services.runner.getRunning(command.fileUri);
  if (running) {
    const stop = vscode.l10n.t('Stop and Continue');
    const picked = await vscode.window.showWarningMessage(
      vscode.l10n.t('"{0}" is still running. Only one operation per file can run at a time.', running.name),
      stop,
    );
    if (picked !== stop) {
      throw new CancelledError();
    }
    await services.runner.stop(command.fileUri);
  }
  if (!progressTitle) {
    return services.runner.execute(command);
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: progressTitle, cancellable: true },
    (_progress, token) => services.runner.execute(command, token),
  );
}

function ensureSucceeded(outcome: CommandOutcome, name: string): void {
  if (outcome.cancelled) {
    throw new CancelledError();
  }
  if (outcome.exitCode !== 0) {
    const code = String(outcome.exitCode ?? '?');
    const lastLine = outcome.output
      ?.split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .pop();
    throw new UserFacingError(
      lastLine
        ? vscode.l10n.t('"{0}" failed (exit code {1}): {2}', name, code, lastLine)
        : vscode.l10n.t('"{0}" failed (exit code {1}). See the terminal for details.', name, code),
    );
  }
}

function revealInOsLabel(): string {
  return process.platform === 'darwin'
    ? vscode.l10n.t('Reveal in Finder')
    : process.platform === 'win32'
      ? vscode.l10n.t('Reveal in File Explorer')
      : vscode.l10n.t('Open Containing Folder');
}

async function runFile(
  services: ToolkitServices,
  uri: vscode.Uri,
  appArgs: readonly string[],
  launchProfile?: string,
): Promise<CommandOutcome> {
  const dotnetPath = await prepareExecution(services, uri, 'run');
  return execute(services, {
    action: 'run',
    fileUri: uri,
    dotnetPath,
    args: buildRunArgs(uri.fsPath, appArgs, launchProfile),
    appArgs,
    name: launchProfile
      ? vscode.l10n.t('Run {0} with profile {1}', path.basename(uri.fsPath), launchProfile)
      : taskName('run', uri),
    focus: true,
  });
}

async function simpleAction(services: ToolkitServices, arg: unknown, action: 'restore' | 'build' | 'clean'): Promise<CommandOutcome> {
  const { uri } = await resolveFileAppTarget(services, arg, action);
  const dotnetPath = await prepareExecution(services, uri, action);
  const name = path.basename(uri.fsPath);
  const spec = {
    restore: { args: buildRestoreArgs, progress: vscode.l10n.t('Restoring {0}…', name), done: vscode.l10n.t('Restore completed for {0}.', name) },
    build: { args: buildBuildArgs, progress: vscode.l10n.t('Building {0}…', name), done: vscode.l10n.t('Build succeeded for {0}.', name) },
    clean: { args: buildCleanArgs, progress: vscode.l10n.t('Cleaning {0}…', name), done: vscode.l10n.t('Clean completed for {0}.', name) },
  }[action];
  const command: DotnetCommand = { action, fileUri: uri, dotnetPath, args: spec.args(uri.fsPath), name: taskName(action, uri) };
  const outcome = await execute(services, command, spec.progress);
  ensureSucceeded(outcome, command.name);
  void vscode.window.showInformationMessage(spec.done);
  return outcome;
}

async function publish(services: ToolkitServices, arg: unknown): Promise<CommandOutcome> {
  const { uri, detection } = await resolveFileAppTarget(services, arg, 'publish');
  const file = uri.fsPath;
  const name = path.basename(file);
  const dir = path.dirname(file);
  const defaultOut = defaultPublishOutputDir(file);

  type OutputItem = vscode.QuickPickItem & { readonly choose: boolean };
  const picked = await vscode.window.showQuickPick<OutputItem>(
    [
      {
        label: `$(folder) ${vscode.l10n.t('Default Output Folder')}`,
        description: path.relative(dir, defaultOut),
        detail: vscode.l10n.t('Chosen by the .NET SDK (artifacts/<name> next to the file unless the file overrides it).'),
        choose: false,
      },
      { label: `$(folder-opened) ${vscode.l10n.t('Choose Output Folder…')}`, choose: true },
    ],
    { title: vscode.l10n.t('Publish {0}', name), placeHolder: vscode.l10n.t('Where should the executable be published?') },
  );
  if (!picked) {
    throw new CancelledError();
  }
  let outputDir: string | undefined;
  if (picked.choose) {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(dir),
      openLabel: vscode.l10n.t('Publish Here'),
      title: vscode.l10n.t('Publish {0}', name),
    });
    if (!folders?.[0]) {
      throw new CancelledError();
    }
    outputDir = folders[0].fsPath;
  }

  const target = outputDir ?? defaultOut;
  const detail = [vscode.l10n.t('Output folder: {0}', target)];
  if (existsSync(target)) {
    detail.push(vscode.l10n.t('The folder already exists; files in it may be overwritten.'));
  }
  if (!isPublishAotDisabled(detection.analysis.directives)) {
    detail.push(
      vscode.l10n.t(
        'File-based apps are published with Native AOT by default. This requires the native toolchain for your platform (on Windows, the Visual Studio "Desktop development with C++" workload) and can take several minutes. Add "#:property PublishAot=false" to the file to publish a framework-dependent app instead.',
      ),
    );
  }
  const confirm = vscode.l10n.t('Publish');
  if ((await vscode.window.showInformationMessage(vscode.l10n.t('Publish {0}?', name), { modal: true, detail: detail.join('\n\n') }, confirm)) !== confirm) {
    throw new CancelledError();
  }

  const dotnetPath = await prepareExecution(services, uri, 'publish');
  const command: DotnetCommand = {
    action: 'publish',
    fileUri: uri,
    dotnetPath,
    args: buildPublishArgs(file, outputDir),
    name: taskName('publish', uri),
  };
  const outcome = await execute(services, command, vscode.l10n.t('Publishing {0}…', name));
  ensureSucceeded(outcome, command.name);
  const reveal = revealInOsLabel();
  void vscode.window.showInformationMessage(vscode.l10n.t('Published {0} to {1}.', name, target), reveal).then((choice) => {
    if (choice === reveal) {
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(existsSync(target) ? target : file));
    }
  });
  return outcome;
}

async function promptConvertFolder(file: string): Promise<string> {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  let suggestion = path.join(dir, `${base}-project`);
  for (let i = 2; existsSync(suggestion) && i < 100; i++) {
    suggestion = path.join(dir, `${base}-project${i}`);
  }
  const value = await vscode.window.showInputBox({
    title: vscode.l10n.t('Convert {0} to a Project', path.basename(file)),
    prompt: vscode.l10n.t('Folder for the new project. It must not exist yet; relative paths are resolved from the file folder.'),
    value: suggestion,
    valueSelection: [suggestion.length - path.basename(suggestion).length, suggestion.length],
    ignoreFocusOut: true,
    validateInput: (input) => {
      if (input.trim().length === 0) {
        return vscode.l10n.t('Enter a folder path.');
      }
      return existsSync(path.resolve(dir, input.trim())) ? vscode.l10n.t('This folder already exists.') : undefined;
    },
  });
  if (value === undefined) {
    throw new CancelledError();
  }
  return path.resolve(dir, value.trim());
}

async function convertToProject(services: ToolkitServices, arg: unknown): Promise<CommandOutcome> {
  const { uri } = await resolveFileAppTarget(services, arg, 'convert');
  const file = uri.fsPath;
  const name = path.basename(file);
  const defaultOut = defaultConvertOutputDir(file);
  const chooseOther = vscode.l10n.t('Choose Another Folder…');
  let outputDir: string | undefined;

  if (existsSync(defaultOut)) {
    const picked = await vscode.window.showWarningMessage(
      vscode.l10n.t('The folder "{0}" already exists.', path.basename(defaultOut)),
      {
        modal: true,
        detail: vscode.l10n.t('"dotnet project convert" creates {0} and never writes into an existing folder. Choose a new folder for the project.', defaultOut),
      },
      chooseOther,
    );
    if (picked !== chooseOther) {
      throw new CancelledError();
    }
    outputDir = await promptConvertFolder(file);
  } else {
    const convert = vscode.l10n.t('Convert');
    const picked = await vscode.window.showInformationMessage(
      vscode.l10n.t('Convert {0} to a project?', name),
      {
        modal: true,
        detail: [
          vscode.l10n.t('A new folder will be created: {0}', defaultOut),
          vscode.l10n.t('It will contain {0} and a copy of {1} whose #: directives are moved into the project file.', path.basename(convertedProjectFile(file, defaultOut)), name),
          vscode.l10n.t('The original file is kept unchanged.'),
        ].join('\n'),
      },
      convert,
      chooseOther,
    );
    if (!picked) {
      throw new CancelledError();
    }
    if (picked === chooseOther) {
      outputDir = await promptConvertFolder(file);
    }
  }

  const dotnetPath = await prepareExecution(services, uri, 'convert');
  const target = outputDir ?? defaultOut;
  // Re-check right before running: never let the CLI run against a folder created meanwhile.
  if (existsSync(target)) {
    throw new UserFacingError(vscode.l10n.t('The folder "{0}" already exists. Nothing was converted.', target), [], 'warning');
  }
  // Newer SDKs can offer to delete the source in interactive mode; keep a copy to guarantee it survives.
  const original = await fs.readFile(file);
  const command: DotnetCommand = {
    action: 'convert',
    fileUri: uri,
    dotnetPath,
    // Explicit --output and a captured (non-interactive) process: the CLI can never prompt for the
    // output folder or for deleting the source file.
    args: buildConvertArgs(file, target),
    name: taskName('convert', uri),
    presentation: 'captured',
  };
  let outcome: CommandOutcome;
  try {
    outcome = await execute(services, command, vscode.l10n.t('Converting {0} to a project…', name));
  } finally {
    if (!existsSync(file)) {
      await fs.writeFile(file, original);
      services.logger.warn(`The .NET CLI removed ${file} during conversion; it was restored.`);
    }
  }
  ensureSucceeded(outcome, command.name);

  const projectFile = convertedProjectFile(file, target);
  try {
    await fs.stat(projectFile);
  } catch {
    throw new UserFacingError(vscode.l10n.t('The .NET CLI reported success, but {0} was not found.', projectFile));
  }
  const openProject = vscode.l10n.t('Open Project File');
  const openFolder = vscode.l10n.t('Open Folder');
  const addToWorkspace = vscode.l10n.t('Add to Workspace');
  void vscode.window
    .showInformationMessage(vscode.l10n.t('Created {0}. The original file was kept.', projectFile), openProject, openFolder, addToWorkspace)
    .then(async (choice) => {
      if (choice === openProject) {
        await vscode.window.showTextDocument(vscode.Uri.file(projectFile));
      } else if (choice === openFolder) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
      } else if (choice === addToWorkspace) {
        vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(target) });
      }
    });
  return outcome;
}

function readLastArgs(services: ToolkitServices): Record<string, string[]> {
  const value = services.context.workspaceState.get<Record<string, string[]>>(LAST_ARGS_STATE_KEY, {});
  return value && typeof value === 'object' ? value : {};
}

async function rememberArgs(services: ToolkitServices, uri: vscode.Uri, args: string[]): Promise<void> {
  const all = { ...readLastArgs(services) };
  delete all[uri.toString()];
  all[uri.toString()] = args;
  const keys = Object.keys(all);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_ARGS))) {
    delete all[key];
  }
  await services.context.workspaceState.update(LAST_ARGS_STATE_KEY, all);
}

async function runWithArgs(services: ToolkitServices, arg: unknown): Promise<CommandOutcome> {
  const { uri } = await resolveFileAppTarget(services, arg, 'run');
  const previous = readLastArgs(services)[uri.toString()] ?? getSettings(uri).runArgs;
  const value = await vscode.window.showInputBox({
    title: vscode.l10n.t('Run {0} with Arguments', path.basename(uri.fsPath)),
    prompt: vscode.l10n.t('Arguments passed to the app. Quote arguments that contain spaces ("a b" or \'a b\'); no shell expansion is performed.'),
    placeHolder: '--name "Ada Lovelace" --count 3',
    value: formatArgumentString(previous),
    ignoreFocusOut: true,
    validateInput: (input) => {
      const parsed = parseArgumentString(input);
      return parsed.ok ? undefined : vscode.l10n.t('Unterminated quote starting at column {0}.', String(parsed.position + 1));
    },
  });
  if (value === undefined) {
    throw new CancelledError();
  }
  const parsed = parseArgumentString(value);
  if (!parsed.ok) {
    throw new UserFacingError(vscode.l10n.t('Unterminated quote starting at column {0}.', String(parsed.position + 1)), [], 'warning');
  }
  await rememberArgs(services, uri, parsed.args);
  return runFile(services, uri, parsed.args);
}

async function launchProfiles(file: string): Promise<readonly LaunchProfile[]> {
  const directory = path.dirname(file);
  const candidates = [
    path.join(directory, 'Properties', 'launchSettings.json'),
    path.join(directory, `${path.basename(file, path.extname(file))}.run.json`),
  ];
  for (const candidate of candidates) {
    const uri = vscode.Uri.file(candidate);
    if (vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString() && document.isDirty)) {
      throw new UserFacingError(vscode.l10n.t('Save the launch settings file before selecting a profile: {0}', candidate), [], 'warning');
    }
    let source: string;
    try {
      source = await fs.readFile(candidate, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    const result = parseLaunchProfiles(source);
    if (!result.ok) {
      throw new UserFacingError(vscode.l10n.t('Could not read launch profiles from {0}: {1}', candidate, result.error));
    }
    return result.profiles;
  }
  return [];
}

async function manageDirectives(services: ToolkitServices, arg: unknown): Promise<void> {
  const { uri } = await resolveFileAppTarget(services, arg, 'run', false);
  const document = await vscode.workspace.openTextDocument(uri);
  const source = document.getText();
  const version = document.version;
  const analysis = analyzeFileAppText(source);
  const items: DirectiveActionItem[] = [
    {
      label: vscode.l10n.t('Add or Update NuGet Package…'),
      description: vscode.l10n.t('Edit the #:package directive'),
      action: 'add-package',
    },
    ...analysis.directives
      .filter((directive) => ['sdk', 'package', 'project', 'property', 'include'].includes(directive.name))
      .map((directive) => ({
        label: `#:${directive.name} ${directive.value}`,
        description: vscode.l10n.t('Line {0}', String(document.positionAt(directive.start).line + 1)),
        action: 'edit-directive' as const,
        directive,
      })),
  ];
  const selected = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Manage File-Based App Directives'),
    placeHolder: vscode.l10n.t('Select a directive to edit or add a package'),
    matchOnDescription: true,
  });
  if (!selected) {
    throw new CancelledError();
  }
  if (selected.action === 'add-package') {
    await editPackageDirective(document, source, analysis, version);
    return;
  }
  if (!selected.directive) {
    throw new Error('The selected directive is missing its source range.');
  }
  if (selected.directive.name === 'package') {
    await editPackageDirective(document, source, analysis, version, selected.directive.value);
    return;
  }
  await editExistingDirective(document, selected.directive, version);
}

async function editPackageDirective(
  document: vscode.TextDocument,
  source: string,
  analysis: ReturnType<typeof analyzeFileAppText>,
  version: number,
  initialValue?: string,
): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: vscode.l10n.t('Add or Update NuGet Package'),
    prompt: vscode.l10n.t('Enter a package reference such as Humanizer@2.14.1.'),
    placeHolder: 'PackageId@Version',
    value: initialValue,
    validateInput: (value) =>
      parsePackageReference(value)
        ? undefined
        : vscode.l10n.t('Enter a valid PackageId@Version reference on one line.'),
  });
  if (input === undefined) {
    throw new CancelledError();
  }
  const reference = parsePackageReference(input);
  if (!reference) {
    throw new UserFacingError(vscode.l10n.t('Enter a valid PackageId@Version reference on one line.'), [], 'warning');
  }
  const matches = analysis.directives.filter(
    (directive) =>
      directive.name === 'package' && packageDirectiveId(directive.value)?.toLowerCase() === reference.id.toLowerCase(),
  );
  if (matches.length > 1) {
    throw new UserFacingError(
      vscode.l10n.t('The package {0} appears in multiple #:package directives. Remove the duplicates before updating it.', reference.id),
      [],
      'warning',
    );
  }
  const existing = matches[0];
  if (existing?.value === reference.value) {
    return;
  }
  const edit = existing
    ? { start: existing.start, end: existing.end, text: `#:package ${reference.value}` }
    : makeDirectiveInsertion(source, analysis, `#:package ${reference.value}`);
  const button = existing ? vscode.l10n.t('Update Package') : vscode.l10n.t('Add Package');
  const prompt = existing
    ? vscode.l10n.t('Update package reference to {0}?', reference.value)
    : vscode.l10n.t('Add package reference {0}?', reference.value);
  const choice = await vscode.window.showWarningMessage(
    prompt,
    {
      modal: true,
      detail: vscode.l10n.t('This edits the #:package directive only. Dependencies are not restored until a .NET CLI operation runs.'),
    },
    button,
  );
  if (choice !== button) {
    throw new CancelledError();
  }
  await applyDirectiveEdit(document, edit, version);
  void vscode.window.showInformationMessage(
    existing
      ? vscode.l10n.t('Updated #:package {0} in {1}.', reference.value, path.basename(document.uri.fsPath))
      : vscode.l10n.t('Added #:package {0} to {1}.', reference.value, path.basename(document.uri.fsPath)),
  );
}

async function editExistingDirective(
  document: vscode.TextDocument,
  directive: FileAppDirective,
  version: number,
): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: vscode.l10n.t('Edit the #:{0} directive', directive.name),
    prompt: vscode.l10n.t('Enter a non-empty directive value on one line.'),
    value: directive.value,
    validateInput: (value) =>
      value.trim().length > 0 && value.length <= 4096 && !/[\r\n]/.test(value)
        ? undefined
        : vscode.l10n.t('Enter a non-empty directive value of at most 4096 characters on one line.'),
  });
  if (input === undefined) {
    throw new CancelledError();
  }
  const value = input.trim();
  if (!value || value.length > 4096 || /[\r\n]/.test(input)) {
    throw new UserFacingError(
      vscode.l10n.t('Enter a non-empty directive value of at most 4096 characters on one line.'),
      [],
      'warning',
    );
  }
  if (value === directive.value) {
    return;
  }
  const button = vscode.l10n.t('Update Directive');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('Update the #:{0} directive?', directive.name),
    {
      modal: true,
      detail: vscode.l10n.t('Change the value from "{0}" to "{1}".', directive.value, value),
    },
    button,
  );
  if (choice !== button) {
    throw new CancelledError();
  }
  await applyDirectiveEdit(document, {
    start: directive.start,
    end: directive.end,
    text: `#:${directive.name} ${value}`,
  }, version);
  void vscode.window.showInformationMessage(vscode.l10n.t('Updated the #:{0} directive in {1}.', directive.name, path.basename(document.uri.fsPath)));
}

async function applyDirectiveEdit(
  document: vscode.TextDocument,
  edit: { readonly start: number; readonly end: number; readonly text: string },
  version: number,
): Promise<void> {
  if (document.version !== version) {
    throw new UserFacingError(
      vscode.l10n.t('The file changed while you were editing its directives. Run the command again to avoid overwriting newer edits.'),
      [],
      'warning',
    );
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.replace(
    document.uri,
    new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
    edit.text,
  );
  if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
    throw new UserFacingError(vscode.l10n.t('Could not update the directive in {0}.', path.basename(document.uri.fsPath)));
  }
}

interface ReferenceActionItem extends vscode.QuickPickItem {
  readonly action: 'list' | 'add' | 'remove';
}

async function manageProjectReferences(services: ToolkitServices, arg: unknown): Promise<CommandOutcome | undefined> {
  const { uri } = await resolveFileAppTarget(services, arg, 'reference');
  const sdk = await services.sdk.require(uri);
  if (!sdk.capabilities.referenceFileCommands) {
    throw new UserFacingError(vscode.l10n.t('Project reference commands for file-based apps require the .NET 11 SDK or later.'), [], 'warning');
  }
  const actions: ReferenceActionItem[] = [
    { label: vscode.l10n.t('List Project References'), action: 'list' },
    { label: vscode.l10n.t('Add Project Reference…'), action: 'add' },
    { label: vscode.l10n.t('Remove Project Reference…'), action: 'remove' },
  ];
  const selected = await vscode.window.showQuickPick(actions, {
    title: vscode.l10n.t('Manage Project References'),
    placeHolder: vscode.l10n.t('Select a project reference action'),
  });
  if (!selected) {
    throw new CancelledError();
  }
  if (selected.action === 'list') {
    const outcome = await runReferenceCommand(services, uri, sdk.dotnetPath, 'list');
    const output = outcome.output?.trim();
    void vscode.window.showInformationMessage(
      output || vscode.l10n.t('No project references are configured for {0}.', path.basename(uri.fsPath)),
    );
    return outcome;
  }
  if (selected.action === 'add') {
    const projectUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: vscode.l10n.t('Add Reference'),
      filters: { [vscode.l10n.t('C# Project')]: ['csproj'] },
    });
    if (!projectUris || projectUris.length === 0) {
      throw new CancelledError();
    }
    const projectPaths = projectUris.map((projectUri) => projectUri.fsPath);
    const addLabel = vscode.l10n.t('Add Reference');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Add project references to {0}?', path.basename(uri.fsPath)),
      {
        modal: true,
        detail: projectPaths.join('\n'),
      },
      addLabel,
    );
    if (choice !== addLabel) {
      throw new CancelledError();
    }
    return runReferenceCommand(services, uri, sdk.dotnetPath, 'add', projectPaths);
  }

  await ensureSaved(uri, getSettings(uri).autoSaveBeforeRun, 'reference');
  const document = await vscode.workspace.openTextDocument(uri);
  const version = document.version;
  const source = await fs.readFile(uri.fsPath, 'utf8');
  const references = analyzeFileAppText(source).directives.filter((directive) => directive.name === 'project');
  if (references.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No project references are configured for {0}.', path.basename(uri.fsPath)));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    references.map((directive) => ({
      label: directive.value,
      description: vscode.l10n.t('Line {0}', String(document.positionAt(directive.start).line + 1)),
      directive,
    })),
    {
      title: vscode.l10n.t('Remove Project Reference'),
      placeHolder: vscode.l10n.t('Select a project reference to remove'),
      matchOnDescription: true,
    },
  );
  if (!picked) {
    throw new CancelledError();
  }
  const removeLabel = vscode.l10n.t('Remove Reference');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('Remove project reference {0}?', picked.directive.value),
    { modal: true, detail: path.basename(uri.fsPath) },
    removeLabel,
  );
  if (choice !== removeLabel) {
    throw new CancelledError();
  }
  if (document.version !== version) {
    throw new UserFacingError(
      vscode.l10n.t('The file changed while you were selecting a project reference. Run the command again.'),
      [],
      'warning',
    );
  }
  return runReferenceCommand(services, uri, sdk.dotnetPath, 'remove', [picked.directive.value]);
}

async function runReferenceCommand(
  services: ToolkitServices,
  uri: vscode.Uri,
  dotnetPath: string,
  operation: 'add' | 'list' | 'remove',
  projects: readonly string[] = [],
): Promise<CommandOutcome> {
  await ensureSaved(uri, getSettings(uri).autoSaveBeforeRun, 'reference');
  const operationName =
    operation === 'add'
      ? vscode.l10n.t('Add Project References')
      : operation === 'list'
        ? vscode.l10n.t('List Project References')
        : vscode.l10n.t('Remove Project References');
  const progressTitle =
    operation === 'add'
      ? vscode.l10n.t('Adding Project References…')
      : operation === 'list'
        ? vscode.l10n.t('Listing Project References…')
        : vscode.l10n.t('Removing Project References…');
  const command: DotnetCommand = {
    action: 'reference',
    fileUri: uri,
    dotnetPath,
    args: buildReferenceArgs(operation, uri.fsPath, projects),
    name: operationName,
    presentation: 'captured',
  };
  const outcome = await execute(services, command, progressTitle);
  ensureSucceeded(outcome, command.name);
  if (operation === 'add') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Added project references to {0}.', path.basename(uri.fsPath)),
    );
  } else if (operation === 'remove') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Removed project references from {0}.', path.basename(uri.fsPath)),
    );
  }
  return outcome;
}

async function formatFile(services: ToolkitServices, arg: unknown): Promise<CommandOutcome> {
  const { uri } = await resolveFileAppTarget(services, arg, 'format');
  const sdk = await services.sdk.require(uri);
  if (!sdk.capabilities.fileBasedAppFormat) {
    throw new UserFacingError(vscode.l10n.t('Formatting file-based apps requires the .NET 11 SDK or later.'), [], 'warning');
  }
  const formatLabel = vscode.l10n.t('Format');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('Format {0}?', path.basename(uri.fsPath)),
    { modal: true, detail: vscode.l10n.t('The .NET formatter will modify this source file.') },
    formatLabel,
  );
  if (choice !== formatLabel) {
    throw new CancelledError();
  }
  await ensureSaved(uri, getSettings(uri).autoSaveBeforeRun, 'format');
  const command: DotnetCommand = {
    action: 'format',
    fileUri: uri,
    dotnetPath: sdk.dotnetPath,
    args: buildFormatArgs(uri.fsPath),
    name: taskName('format', uri),
    presentation: 'captured',
  };
  const outcome = await execute(services, command, vscode.l10n.t('Formatting {0}…', path.basename(uri.fsPath)));
  ensureSucceeded(outcome, command.name);
  void vscode.window.showInformationMessage(vscode.l10n.t('Formatted {0}.', path.basename(uri.fsPath)));
  return outcome;
}

async function runWithProfile(services: ToolkitServices, arg: unknown): Promise<CommandOutcome> {
  const { uri } = await resolveFileAppTarget(services, arg, 'run');
  const profiles = await launchProfiles(uri.fsPath);
  if (profiles.length === 0) {
    throw new UserFacingError(vscode.l10n.t('No supported launch profiles were found for {0}.', path.basename(uri.fsPath)), [], 'info');
  }
  const items = profiles.map((profile) => ({
    label: profile.name,
    description: profile.commandName,
    profile,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Run {0} with a Launch Profile', path.basename(uri.fsPath)),
    placeHolder: vscode.l10n.t('Select a launch profile'),
    matchOnDescription: true,
  });
  if (!picked) {
    throw new CancelledError();
  }
  return runFile(services, uri, getSettings(uri).runArgs, picked.profile.name);
}

async function packAsTool(services: ToolkitServices, arg: unknown): Promise<CommandOutcome> {
  const { uri, detection } = await resolveFileAppTarget(services, arg, 'pack');
  if (isPackAsToolDisabled(detection.analysis.directives)) {
    throw new UserFacingError(vscode.l10n.t('This file sets PackAsTool=false. Remove or update that directive before packing it as a tool.'), [], 'warning');
  }
  const dotnetPath = await prepareExecution(services, uri, 'pack');
  const command: DotnetCommand = {
    action: 'pack',
    fileUri: uri,
    dotnetPath,
    args: buildPackArgs(uri.fsPath),
    name: taskName('pack', uri),
  };
  const outcome = await execute(services, command, vscode.l10n.t('Packing {0} as a tool…', path.basename(uri.fsPath)));
  ensureSucceeded(outcome, command.name);
  void vscode.window.showInformationMessage(vscode.l10n.t('Packed {0} as a tool.', path.basename(uri.fsPath)));
  return outcome;
}

async function cleanFileAppCache(services: ToolkitServices, arg: unknown): Promise<CommandOutcome> {
  const { uri } = await resolveFileAppTarget(services, arg, 'clean');
  const sdk = await services.sdk.require(uri);
  const value = await vscode.window.showInputBox({
    title: vscode.l10n.t('Clean File-Based App Cache'),
    prompt: vscode.l10n.t('Remove cache artifacts unused for at least this many days.'),
    value: '30',
    validateInput: (input) => {
      const days = Number(input);
      return /^\d+$/.test(input) && Number.isSafeInteger(days) && days <= 2_147_483_647
        ? undefined
        : vscode.l10n.t('Enter a whole number from 0 to {0}.', '2147483647');
    },
  });
  if (value === undefined) {
    throw new CancelledError();
  }
  const days = Number(value);
  const cleanLabel = vscode.l10n.t('Clean Cache');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('Clean file-based app cache?'),
    {
      modal: true,
      detail: vscode.l10n.t('This removes cached build artifacts that have been unused for at least {0} days.', String(days)),
    },
    cleanLabel,
  );
  if (choice !== cleanLabel) {
    throw new CancelledError();
  }
  const command: DotnetCommand = {
    action: 'clean',
    fileUri: uri,
    dotnetPath: sdk.dotnetPath,
    args: buildFileAppCacheCleanArgs(days),
    name: vscode.l10n.t('Clean File-Based App Cache'),
    presentation: 'captured',
    exclusive: true,
  };
  const outcome = await execute(services, command, vscode.l10n.t('Cleaning file-based app cache…'));
  ensureSucceeded(outcome, command.name);
  void vscode.window.showInformationMessage(vscode.l10n.t('File-based app cache cleanup completed.'));
  return outcome;
}

export function registerActionCommands(services: ToolkitServices): void {
  registerCommand(services, COMMANDS.runFile, async (arg) => {
    const { uri } = await resolveFileAppTarget(services, arg, 'run');
    return runFile(services, uri, getSettings(uri).runArgs);
  });
  registerCommand(services, COMMANDS.runWithArgs, (arg) => runWithArgs(services, arg));
  registerCommand(services, COMMANDS.runWithProfile, (arg) => runWithProfile(services, arg));
  registerCommand(services, COMMANDS.manageDirectives, (arg) => manageDirectives(services, arg));
  registerCommand(services, COMMANDS.manageProjectReferences, (arg) => manageProjectReferences(services, arg));
  registerCommand(services, COMMANDS.formatFile, (arg) => formatFile(services, arg));
  registerCommand(services, COMMANDS.restore, (arg) => simpleAction(services, arg, 'restore'));
  registerCommand(services, COMMANDS.build, (arg) => simpleAction(services, arg, 'build'));
  registerCommand(services, COMMANDS.clean, (arg) => simpleAction(services, arg, 'clean'));
  registerCommand(services, COMMANDS.publish, (arg) => publish(services, arg));
  registerCommand(services, COMMANDS.convertToProject, (arg) => convertToProject(services, arg));
  registerCommand(services, COMMANDS.packAsTool, (arg) => packAsTool(services, arg));
  registerCommand(services, COMMANDS.cleanFileAppCache, (arg) => cleanFileAppCache(services, arg));
  registerTaggedCommentActions(services);
}
