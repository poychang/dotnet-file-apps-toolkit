import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../core/logging';
import { getSettings } from '../core/settings';
import {
  analyzeFileAppText,
  decideFileApp,
  needsProjectConeCheck,
  type FileAppDecision,
  type FileAppOverride,
  type FileAppTextAnalysis,
} from './fileAppSignals';

export const FILE_APP_URIS_CONTEXT_KEY = 'dotnetFileApps.fileAppUris';
const OVERRIDES_STATE_KEY = 'dotnetFileApps.overrides';
const PROJECT_FILE_RE = /\.(cs|fs|vb)proj$/i;
const MAX_ANCESTOR_DEPTH = 32;
const DIR_CACHE_TTL_MS = 30_000;

export interface DetectionResult {
  readonly uri: vscode.Uri;
  readonly analysis: FileAppTextAnalysis;
  readonly decision: FileAppDecision;
}

export function isCSharpFileUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && path.extname(uri.fsPath).toLowerCase() === '.cs';
}

/**
 * Tracks which open `.cs` documents are .NET file-based apps and publishes them through the
 * `dotnetFileApps.fileAppUris` context key so editor-title actions are shown per editor.
 */
export class FileAppDetector implements vscode.Disposable {
  private readonly results = new Map<string, { version: number; result: DetectionResult }>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dirCache = new Map<string, { at: number; hasProject: Promise<boolean> }>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPublished = '';

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly logger: Logger,
  ) {
    const projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.{csproj,fsproj,vbproj}', false, true, false);
    const invalidateDirs = () => {
      this.dirCache.clear();
      this.refreshAll();
    };
    this.disposables.push(
      this.changeEmitter,
      projectWatcher,
      projectWatcher.onDidCreate(invalidateDirs),
      projectWatcher.onDidDelete(invalidateDirs),
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document, 300)),
      vscode.workspace.onDidCloseTextDocument((d) => this.forget(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dotnetFileAppsToolkit.fileDetection') || e.affectsConfiguration('dotnetFileAppsToolkit.enabled')) {
          this.refreshAll();
        }
      }),
    );
    this.refreshAll();
  }

  /** Last known decision for an open document. */
  isFileApp(uri: vscode.Uri): boolean | undefined {
    return this.results.get(uri.toString())?.result.decision.isFileApp;
  }

  /** Detects a file using the open document's text when available, otherwise the file on disk. */
  async detect(uri: vscode.Uri): Promise<DetectionResult> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const text = doc ? doc.getText() : await fs.readFile(uri.fsPath, 'utf8');
    return this.evaluate(uri, text);
  }

  getOverride(uri: vscode.Uri): FileAppOverride | undefined {
    return this.readOverrides()[uri.toString()];
  }

  async setOverride(uri: vscode.Uri, value: FileAppOverride | undefined): Promise<void> {
    const overrides = { ...this.readOverrides() };
    if (value) {
      overrides[uri.toString()] = value;
    } else {
      delete overrides[uri.toString()];
    }
    await this.state.update(OVERRIDES_STATE_KEY, overrides);
    this.refreshAll();
  }

  refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) {
      this.schedule(doc, 0, true);
    }
    this.publishSoon();
  }

  private readOverrides(): Record<string, FileAppOverride> {
    const value = this.state.get<Record<string, FileAppOverride>>(OVERRIDES_STATE_KEY, {});
    return value && typeof value === 'object' ? value : {};
  }

  private schedule(doc: vscode.TextDocument, delayMs: number, force = false): void {
    if (!isCSharpFileUri(doc.uri)) {
      return;
    }
    const key = doc.uri.toString();
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        if (doc.isClosed) {
          return;
        }
        const version = doc.version;
        const cached = this.results.get(key);
        if (!force && cached && cached.version === version) {
          return;
        }
        this.evaluate(doc.uri, doc.getText())
          .then((result) => {
            if (!doc.isClosed) {
              this.results.set(key, { version, result });
              this.publishSoon();
            }
          })
          .catch((err) => this.logger.warn(`File-app detection failed for ${doc.uri.fsPath}: ${err}`));
      }, delayMs),
    );
  }

  private forget(uri: vscode.Uri): void {
    const key = uri.toString();
    const t = this.pending.get(key);
    if (t) {
      clearTimeout(t);
      this.pending.delete(key);
    }
    if (this.results.delete(key)) {
      this.publishSoon();
    }
  }

  private async evaluate(uri: vscode.Uri, text: string): Promise<DetectionResult> {
    const settings = getSettings(uri);
    const analysis = analyzeFileAppText(text);
    const inProjectCone = needsProjectConeCheck(settings.fileDetection, analysis) ? await this.isInsideProjectCone(uri) : false;
    const decision = decideFileApp(settings.fileDetection, this.getOverride(uri), analysis, inProjectCone);
    this.logger.trace(`Detection ${uri.fsPath}: ${decision.isFileApp} (${decision.reason})`);
    return { uri, analysis, decision };
  }

  private async isInsideProjectCone(uri: vscode.Uri): Promise<boolean> {
    let dir = path.dirname(uri.fsPath);
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
      if (await this.directoryHasProject(dir)) {
        return true;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return false;
  }

  private directoryHasProject(dir: string): Promise<boolean> {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    const cached = this.dirCache.get(key);
    if (cached && Date.now() - cached.at < DIR_CACHE_TTL_MS) {
      return cached.hasProject;
    }
    const hasProject = fs
      .readdir(dir)
      .then((names) => names.some((n) => PROJECT_FILE_RE.test(n)))
      .catch(() => false);
    this.dirCache.set(key, { at: Date.now(), hasProject });
    return hasProject;
  }

  private publishSoon(): void {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
    }
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      const enabled = getSettings().enabled;
      const uris = enabled
        ? [...this.results.entries()].filter(([, v]) => v.result.decision.isFileApp).map(([k]) => k).sort()
        : [];
      const serialized = JSON.stringify(uris);
      if (serialized !== this.lastPublished) {
        this.lastPublished = serialized;
        void vscode.commands.executeCommand('setContext', FILE_APP_URIS_CONTEXT_KEY, uris);
        this.changeEmitter.fire();
      }
    }, 50);
  }

  dispose(): void {
    this.pending.forEach((t) => clearTimeout(t));
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
