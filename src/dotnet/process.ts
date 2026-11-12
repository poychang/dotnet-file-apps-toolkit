import { execFile } from 'node:child_process';

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Node error code such as `ENOENT` or `ETIMEDOUT`, when the process could not run or was killed. */
  readonly errorCode?: string;
}

export interface ProbeOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Runs a short-lived process without a shell and captures bounded output.
 * Never throws; failures are reported through the result.
 */
export function runProbe(file: string, args: readonly string[], options: ProbeOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 20_000,
        maxBuffer: options.maxBufferBytes ?? 1024 * 1024,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        env: options.env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const e = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
        if (typeof e.code === 'number') {
          resolve({ exitCode: e.code, stdout, stderr });
          return;
        }
        resolve({
          exitCode: null,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          errorCode: e.killed ? 'ETIMEDOUT' : (e.code ?? 'EUNKNOWN'),
        });
      },
    );
  });
}

/** Environment for dotnet probes: suppress first-run banners that would pollute parsable output. */
export function dotnetProbeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
  };
}
