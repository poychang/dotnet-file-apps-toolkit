export interface SdkVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly raw: string;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSdkVersion(value: string): SdkVersion | undefined {
  const raw = value.trim();
  const m = VERSION_RE.exec(raw);
  if (!m) {
    return undefined;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    raw,
  };
}

/** Picks the SDK version from `dotnet --version` output, ignoring first-run banners or warnings. */
export function extractSdkVersion(stdout: string): SdkVersion | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = parseSdkVersion(lines[i]);
    if (v) {
      return v;
    }
  }
  return undefined;
}

function comparePrereleaseIdentifiers(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  // A release version has higher precedence than any of its prereleases.
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) {
        return Math.sign(d);
      }
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareSdkVersions(a: SdkVersion, b: SdkVersion): number {
  return (
    Math.sign(a.major - b.major) ||
    Math.sign(a.minor - b.minor) ||
    Math.sign(a.patch - b.patch) ||
    comparePrereleaseIdentifiers(a.prerelease, b.prerelease)
  );
}

function coreAtLeast(v: SdkVersion, major: number, minor: number, patch: number): boolean {
  if (v.major !== major) {
    return v.major > major;
  }
  if (v.minor !== minor) {
    return v.minor > minor;
  }
  return v.patch >= patch;
}

export const MINIMUM_FILE_APP_SDK = '10.0.100';

export interface SdkCapabilities {
  /** `dotnet run --file`, build/restore/clean/publish/pack on a `.cs` file, `dotnet project convert`. */
  readonly fileBasedApps: boolean;
  /** `#:include` directive for source files. */
  readonly includeDirective: boolean;
  /** `#:include` referencing a compiled DLL. */
  readonly includeDllDirective: boolean;
  /** `dotnet reference add/list/remove --file`. */
  readonly referenceFileCommands: boolean;
  /** True when the SDK is a prerelease build; features may be incomplete. */
  readonly prerelease: boolean;
}

/**
 * Feature gating per the official .NET file-based apps documentation.
 * Prerelease builds of a band are treated as that band so early adopters are not blocked,
 * but `prerelease` lets callers surface a warning.
 */
export function getSdkCapabilities(v: SdkVersion): SdkCapabilities {
  return {
    fileBasedApps: v.major >= 10,
    includeDirective: v.major >= 11 || coreAtLeast(v, 10, 0, 300),
    includeDllDirective: v.major >= 11,
    referenceFileCommands: v.major >= 11,
    prerelease: v.prerelease.length > 0,
  };
}
