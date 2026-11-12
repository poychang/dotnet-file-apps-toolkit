import * as path from 'node:path';
import type { FileAppDirective } from './fileAppSignals';

export type DotnetAction = 'run' | 'restore' | 'build' | 'clean' | 'publish' | 'convert';

/** `dotnet run --file <file> [-- <appArgs...>]`. `--file` prevents a project in the cwd from being run instead. */
export function buildRunArgs(file: string, appArgs: readonly string[] = []): string[] {
  const args = ['run', '--file', file];
  if (appArgs.length > 0) {
    args.push('--', ...appArgs);
  }
  return args;
}

export function buildRestoreArgs(file: string): string[] {
  return ['restore', file];
}

export function buildBuildArgs(file: string): string[] {
  return ['build', file];
}

export function buildCleanArgs(file: string): string[] {
  return ['clean', file];
}

export function buildPublishArgs(file: string, outputDir?: string): string[] {
  return outputDir ? ['publish', file, '--output', outputDir] : ['publish', file];
}

export function buildConvertArgs(file: string, outputDir?: string): string[] {
  return outputDir ? ['project', 'convert', file, '--output', outputDir] : ['project', 'convert', file];
}

/** Folder `dotnet project convert` creates when `--output` is omitted: `<dir>/<basename>`. */
export function defaultConvertOutputDir(file: string): string {
  return path.join(path.dirname(file), path.basename(file, path.extname(file)));
}

/** Folder `dotnet publish <file.cs>` writes to when `--output` is omitted: `<dir>/artifacts/<basename>`. */
export function defaultPublishOutputDir(file: string): string {
  return path.join(path.dirname(file), 'artifacts', path.basename(file, path.extname(file)));
}

/** Path of the project file created by `dotnet project convert` inside `outputDir`. */
export function convertedProjectFile(file: string, outputDir: string): string {
  return path.join(outputDir, `${path.basename(file, path.extname(file))}.csproj`);
}

/** True when the file opts out of Native AOT publishing with `#:property PublishAot=false`. */
export function isPublishAotDisabled(directives: readonly FileAppDirective[]): boolean {
  return directives.some((d) => d.name.toLowerCase() === 'property' && /^PublishAot\s*=\s*false\s*$/i.test(d.value.trim()));
}

/** A display form of a command line for logs; never executed by a shell. */
export function formatCommandLine(executable: string, args: readonly string[]): string {
  return [executable, ...args].map((a) => (a === '' || /[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

export type ParseArgumentsResult =
  | { readonly ok: true; readonly args: string[] }
  | { readonly ok: false; readonly error: 'unterminated-double-quote' | 'unterminated-single-quote'; readonly position: number };

/**
 * Splits a user-typed argument string into discrete arguments without involving a shell.
 *
 * - Whitespace separates arguments.
 * - `"..."` groups text; inside it, `\"` is a literal quote and every other character is literal.
 * - `'...'` groups text literally (no escapes).
 * - Outside quotes, `\"` and `\'` produce literal quotes; other backslashes are literal (Windows paths).
 * - Adjacent segments concatenate (`a"b c"` → `ab c`); `""` produces an empty argument.
 */
export function parseArgumentString(input: string): ParseArgumentsResult {
  const args: string[] = [];
  let current = '';
  let inArg = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      if (inArg) {
        args.push(current);
        current = '';
        inArg = false;
      }
      i++;
      continue;
    }
    inArg = true;
    if (ch === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < input.length) {
        const c = input[i];
        if (c === '\\' && input[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        current += c;
        i++;
      }
      if (!closed) {
        return { ok: false, error: 'unterminated-double-quote', position: start };
      }
      continue;
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) {
        return { ok: false, error: 'unterminated-single-quote', position: i };
      }
      current += input.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '\\' && (input[i + 1] === '"' || input[i + 1] === "'")) {
      current += input[i + 1];
      i += 2;
      continue;
    }
    current += ch;
    i++;
  }
  if (inArg) {
    args.push(current);
  }
  return { ok: true, args };
}

/** Formats arguments so that `parseArgumentString(formatArgumentString(args))` returns `args`. */
export function formatArgumentString(args: readonly string[]): string {
  return args.map(quoteArgument).join(' ');
}

function quoteArgument(arg: string): string {
  if (arg.length > 0 && !/[\s"']/.test(arg)) {
    return arg;
  }
  if (!/["\\]/.test(arg)) {
    return `"${arg}"`;
  }
  if (!arg.includes("'")) {
    return `'${arg}'`;
  }
  // Single-quoted segments are fully literal; embed each `'` as a double-quoted segment.
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}
