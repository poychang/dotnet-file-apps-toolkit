// @ts-check
import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// Tests create files (convert, publish), so they run against a disposable copy of the fixtures.
const workspaceFolder = mkdtempSync(join(tmpdir(), 'dotnet-file-apps-it-'));
cpSync('fixtures', workspaceFolder, { recursive: true });

export default defineConfig({
  label: 'integration',
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder,
  // Set VSCODE_TEST_EXECUTABLE to reuse a local VS Code install instead of downloading one.
  ...(process.env.VSCODE_TEST_EXECUTABLE
    ? { useInstallation: { fromPath: process.env.VSCODE_TEST_EXECUTABLE } }
    : { version: process.env.VSCODE_TEST_VERSION ?? 'stable' }),
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  env: { DOTNET_FILE_APPS_IT_WORKSPACE: workspaceFolder },
  mocha: { ui: 'bdd', timeout: 300_000, color: true },
});
