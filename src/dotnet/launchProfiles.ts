import { parse as parseJson, printParseErrorCode, type ParseError } from 'jsonc-parser/lib/esm/main.js';

export interface LaunchProfile {
  readonly name: string;
  readonly commandName: 'Project' | 'Executable';
}

export type LaunchProfileParseResult =
  | { readonly ok: true; readonly profiles: readonly LaunchProfile[] }
  | { readonly ok: false; readonly error: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Parses the JSON-with-comments launch settings format accepted by `dotnet run`. */
export function parseLaunchProfiles(source: string): LaunchProfileParseResult {
  const errors: ParseError[] = [];
  const value: unknown = parseJson(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (errors.length > 0) {
    return { ok: false, error: printParseErrorCode(errors[0].error) };
  }
  const root = record(value);
  if (!root) {
    return { ok: false, error: 'Launch settings must contain a JSON object.' };
  }
  if (root.profiles === undefined) {
    return { ok: true, profiles: [] };
  }
  const profiles = record(root.profiles);
  if (!profiles) {
    return { ok: false, error: 'The profiles property must be a JSON object.' };
  }
  const parsed: LaunchProfile[] = [];
  const names = new Set<string>();
  for (const [name, rawProfile] of Object.entries(profiles)) {
    if (!name.trim()) {
      continue;
    }
    const key = name.toLowerCase();
    if (names.has(key)) {
      return { ok: false, error: `Profile names that differ only by case are ambiguous: ${name}` };
    }
    names.add(key);
    const commandName = record(rawProfile)?.commandName;
    if (commandName !== 'Project' && commandName !== 'Executable') {
      continue;
    }
    parsed.push({ name, commandName });
  }
  return { ok: true, profiles: parsed };
}
