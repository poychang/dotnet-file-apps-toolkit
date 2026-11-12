import * as vscode from 'vscode';
import type { DetectionMode } from '../dotnet/fileAppSignals';

export const CONFIG_SECTION = 'dotnetFileAppsToolkit';

export type AutoSaveBeforeRun = 'prompt' | 'always' | 'never';
export type HighlightStrategy = 'auto' | 'injection' | 'decorations' | 'off';

export interface ToolkitSettings {
  readonly enabled: boolean;
  readonly fileDetection: DetectionMode;
  readonly dotnetPath: string;
  readonly autoSaveBeforeRun: AutoSaveBeforeRun;
  readonly runArgs: readonly string[];
  readonly comments: {
    readonly enabled: boolean;
    readonly highlightEnabled: boolean;
    readonly highlightStrategy: HighlightStrategy;
    readonly markdownHover: boolean;
    readonly previewOnOpen: boolean;
    readonly unknownTagDiagnostic: boolean;
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function getSettings(scope?: vscode.ConfigurationScope): ToolkitSettings {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION, scope);
  const runArgs = c.get<unknown>('run.args', []);
  const dotnetPath = c.get<string>('dotnetPath', 'dotnet');
  return {
    enabled: c.get<boolean>('enabled', true),
    fileDetection: oneOf(c.get('fileDetection'), ['strict', 'standalone', 'manual'], 'strict'),
    dotnetPath: typeof dotnetPath === 'string' && dotnetPath.trim().length > 0 ? dotnetPath.trim() : 'dotnet',
    autoSaveBeforeRun: oneOf(c.get('autoSaveBeforeRun'), ['prompt', 'always', 'never'], 'prompt'),
    runArgs: Array.isArray(runArgs) ? runArgs.filter((a): a is string => typeof a === 'string') : [],
    comments: {
      enabled: c.get<boolean>('comments.enabled', true),
      highlightEnabled: c.get<boolean>('comments.highlight.enabled', true),
      highlightStrategy: oneOf(c.get('comments.highlight.strategy'), ['auto', 'injection', 'decorations', 'off'], 'auto'),
      markdownHover: c.get<boolean>('comments.markdown.hover', true),
      previewOnOpen: c.get<boolean>('comments.previewOnOpen', false),
      unknownTagDiagnostic: c.get<boolean>('comments.unknownTagDiagnostic', false),
    },
  };
}
