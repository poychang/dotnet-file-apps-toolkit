import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../core/logging';
import { getSettings } from '../core/settings';
import { UserFacingError } from '../core/errors';
import { dotnetProbeEnv, runProbe } from './process';
import { extractSdkVersion, getSdkCapabilities, MINIMUM_FILE_APP_SDK, type SdkCapabilities, type SdkVersion } from './sdkVersion';

export const SDK_DOWNLOAD_URL = 'https://dotnet.microsoft.com/download/dotnet';
export const FILE_APPS_DOCS_URL = 'https://learn.microsoft.com/dotnet/core/sdk/file-based-apps';

export type SdkProbeResult =
  | {
      readonly ok: true;
      readonly dotnetPath: string;
      readonly cwd: string;
      readonly version: SdkVersion;
      readonly capabilities: SdkCapabilities;
    }
  | {
      readonly ok: false;
      readonly dotnetPath: string;
      readonly cwd: string;
      readonly reason: 'not-found' | 'timeout' | 'failed' | 'unparsable' | 'unsupported';
      readonly detail: string;
      readonly version?: SdkVersion;
    };

const CACHE_TTL_MS = 60_000;

/** Resolves the .NET SDK that applies to a given source file (honoring global.json via cwd). */
export class SdkService implements vscode.Disposable {
  private readonly cache = new Map<string, { at: number; result: Promise<SdkProbeResult> }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly logger: Logger) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/global.json');
    const clear = () => this.cache.clear();
    this.disposables.push(
      watcher,
      watcher.onDidChange(clear),
      watcher.onDidCreate(clear),
      watcher.onDidDelete(clear),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dotnetFileAppsToolkit.dotnetPath')) {
          clear();
        }
      }),
    );
  }

  probe(fileUri: vscode.Uri, options: { force?: boolean } = {}): Promise<SdkProbeResult> {
    return this.probeDirectory(path.dirname(fileUri.fsPath), fileUri, options);
  }

  /** Probes the SDK selected for `cwd`; `scope` selects the settings scope for `dotnetPath`. */
  probeDirectory(cwd: string, scope?: vscode.Uri, options: { force?: boolean } = {}): Promise<SdkProbeResult> {
    const dotnetPath = getSettings(scope).dotnetPath;
    const key = `${dotnetPath}\u0000${cwd}`;
    const cached = this.cache.get(key);
    if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.result;
    }
    const result = this.runProbe(dotnetPath, cwd);
    this.cache.set(key, { at: Date.now(), result });
    return result;
  }

  /** Probes and throws a user-facing error when the SDK cannot run file-based apps. */
  async require(fileUri: vscode.Uri): Promise<Extract<SdkProbeResult, { ok: true }>> {
    const result = await this.probe(fileUri);
    if (result.ok) {
      if (result.capabilities.prerelease) {
        this.logger.warn(`Using prerelease .NET SDK ${result.version.raw}; some file-based app features may be unavailable.`);
      }
      return result;
    }
    // Retry once without cache in case the user just installed an SDK.
    const fresh = await this.probe(fileUri, { force: true });
    if (fresh.ok) {
      return fresh;
    }
    throw sdkProbeError(fresh);
  }

  private async runProbe(dotnetPath: string, cwd: string): Promise<SdkProbeResult> {
    this.logger.debug(`Probing .NET SDK: ${dotnetPath} --version (cwd: ${cwd})`);
    const r = await runProbe(dotnetPath, ['--version'], { cwd, timeoutMs: 20_000, env: dotnetProbeEnv() });
    if (r.errorCode === 'ENOENT') {
      return { ok: false, dotnetPath, cwd, reason: 'not-found', detail: `'${dotnetPath}' was not found.` };
    }
    if (r.errorCode === 'ETIMEDOUT') {
      return { ok: false, dotnetPath, cwd, reason: 'timeout', detail: `'${dotnetPath} --version' timed out.` };
    }
    if (r.errorCode) {
      return { ok: false, dotnetPath, cwd, reason: 'failed', detail: `${r.errorCode}: ${r.stderr.trim()}` };
    }
    if (r.exitCode !== 0) {
      const detail = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).slice(0, 12).join('\n');
      this.logger.warn(`'dotnet --version' exited with ${r.exitCode} in ${cwd}:\n${detail}`);
      return { ok: false, dotnetPath, cwd, reason: 'failed', detail };
    }
    const version = extractSdkVersion(r.stdout);
    if (!version) {
      return { ok: false, dotnetPath, cwd, reason: 'unparsable', detail: r.stdout.trim().slice(0, 500) };
    }
    const capabilities = getSdkCapabilities(version);
    this.logger.info(`.NET SDK ${version.raw} resolved for ${cwd}`);
    if (!capabilities.fileBasedApps) {
      return {
        ok: false,
        dotnetPath,
        cwd,
        reason: 'unsupported',
        version,
        detail: `.NET SDK ${version.raw} does not support file-based apps (requires ${MINIMUM_FILE_APP_SDK} or later).`,
      };
    }
    return { ok: true, dotnetPath, cwd, version, capabilities };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.cache.clear();
  }
}

export function sdkProbeError(result: Extract<SdkProbeResult, { ok: false }>): UserFacingError {
  const download = {
    title: vscode.l10n.t('Download .NET SDK'),
    run: () => vscode.env.openExternal(vscode.Uri.parse(SDK_DOWNLOAD_URL)),
  };
  const openSettings = {
    title: vscode.l10n.t('Open Settings'),
    run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'dotnetFileAppsToolkit.dotnetPath'),
  };
  switch (result.reason) {
    case 'not-found':
      return new UserFacingError(
        vscode.l10n.t(
          'The .NET SDK was not found ("{0}"). Install .NET SDK {1} or later, or set "dotnetFileAppsToolkit.dotnetPath".',
          result.dotnetPath,
          MINIMUM_FILE_APP_SDK,
        ),
        [download, openSettings],
      );
    case 'unsupported':
      return new UserFacingError(
        vscode.l10n.t(
          '.NET SDK {0} is selected for this folder, but file-based apps require .NET SDK {1} or later. Check global.json or install a newer SDK.',
          result.version?.raw ?? '?',
          MINIMUM_FILE_APP_SDK,
        ),
        [download],
      );
    case 'timeout':
      return new UserFacingError(vscode.l10n.t('Timed out while querying the .NET SDK version.'), [openSettings]);
    case 'unparsable':
      return new UserFacingError(vscode.l10n.t('Could not determine the .NET SDK version from "dotnet --version".'));
    case 'failed':
    default:
      return new UserFacingError(
        vscode.l10n.t(
          'The .NET SDK could not be resolved for this folder. A global.json may pin an SDK that is not installed. Details: {0}',
          result.detail.split(/\r?\n/)[0] ?? '',
        ),
        [download],
      );
  }
}
