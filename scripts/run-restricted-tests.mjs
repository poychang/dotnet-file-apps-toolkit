// @ts-check
// Runs out/test/restricted in an untrusted workspace. @vscode/test-electron always passes
// --disable-workspace-trust, so this script launches VS Code itself with workspace trust enabled.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const executable =
  process.env.VSCODE_TEST_EXECUTABLE ??
  (await downloadAndUnzipVSCode({ version: process.env.VSCODE_TEST_VERSION ?? 'stable', cachePath: join(root, '.vscode-test') }));

const workspace = mkdtempSync(join(tmpdir(), 'dotnet-file-apps-restricted-'));
cpSync(join(root, 'fixtures'), workspace, { recursive: true });
writeJson(join(workspace, '.vscode', 'settings.json'), {
  // Restricted settings: VS Code must ignore these workspace values in Restricted Mode.
  'dotnetFileAppsToolkit.dotnetPath': './untrusted/dotnet',
  'dotnetFileAppsToolkit.run.args': ['--from-untrusted-workspace'],
  // Not restricted, so it proves the workspace settings are still read.
  'dotnetFileAppsToolkit.codeLens.enabled': true,
});

// macOS limits Unix socket paths, and VS Code creates sockets in the user data directory.
const userDataDir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'dfat-r-'));
writeJson(join(userDataDir, 'User', 'settings.json'), {
  'security.workspace.trust.enabled': true,
  'security.workspace.trust.startupPrompt': 'never',
  'security.workspace.trust.banner': 'never',
  'security.workspace.trust.untrustedFiles': 'open',
});

const args = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-updates',
  '--skip-welcome',
  '--skip-release-notes',
  '--no-cached-data',
  '--disable-extensions',
  `--user-data-dir=${userDataDir}`,
  `--extensions-dir=${join(userDataDir, 'extensions')}`,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${join(root, 'out', 'test', 'restricted', 'index.js')}`,
  workspace,
];
const env = { ...process.env, DOTNET_FILE_APPS_IT_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE;

const exitCode = await new Promise((resolveExit) => {
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('error', (err) => {
    console.error(`Failed to start VS Code: ${err.message}`);
    resolveExit(1);
  });
  child.on('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
});

for (const dir of [workspace, userDataDir]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`Could not remove ${dir}: ${err instanceof Error ? err.message : err}`);
  }
}
process.exit(exitCode);
